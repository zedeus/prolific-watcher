import type { SubmissionRecord, StudyAvailabilityEventRecord, ResearcherRecord } from './db';
import type { Study } from './types';
import { trimString } from './format';
import { categorizeStatus, researcherRefFromPayload } from './submission-analytics';
import { firstListingDurationSeconds } from './study-history';
import {
  extractSubmissionReward,
  extractDurationSeconds,
  perSubmissionHourly,
  summarizeRates,
  detectDefaultCurrency,
  recordEventTime,
  quantile,
  type RateStats,
} from './earnings';

// ──────────────────────────────────────────────────────────────
// Reliability score tuning
// ──────────────────────────────────────────────────────────────

/** Terminal outcomes needed before a reliability score is meaningful (below this → "unknown"). */
export const RELIABILITY_MIN_TERMINAL = 3;
// Bayesian shrink for the fairness term: pretend we've already seen a researcher approve
// FAIRNESS_PRIOR_MEAN of FAIRNESS_PRIOR_STRENGTH submissions. Keeps one early rejection from
// tanking a brand-new researcher, while real volume quickly overwhelms the prior.
const FAIRNESS_PRIOR_MEAN = 0.9;
const FAIRNESS_PRIOR_STRENGTH = 4;
/** Screen-out rate at which the screen-out sub-score bottoms out at 0. */
const SCREEN_OUT_ZERO_AT = 0.5;
const FAIRNESS_WEIGHT = 0.75;
const SCREEN_WEIGHT = 0.25;

// ──────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────

export type ReliabilityBand = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown';

export interface ReliabilityScore {
  /** 0..100 composite. Meaningful only when `hasEnoughData`. */
  score: number;
  band: ReliabilityBand;
  hasEnoughData: boolean;
}

export interface ResearcherStatusCounts {
  approved: number;
  awaiting_review: number;
  returned: number;
  rejected: number;
  screened_out: number;
  other: number;
}

export interface ResearcherMetrics {
  /** Submitted submissions seen for this researcher. */
  total: number;
  counts: ResearcherStatusCounts;
  /** approved + returned + rejected + screened_out. */
  terminal: number;
  /** approved + returned + rejected (the "your work was judged" set — screen-out excluded). */
  decided: number;
  /** approved / decided; null when no decided submissions. */
  approval_rate: number | null;
  /** screened_out / terminal; null when no terminal submissions. */
  screened_out_rate: number | null;
  /** Dominant reward currency across submissions ('' when none). Money stats use only this currency. */
  currency: string;
  /** Per-submission £/hr summary (outlier-trimmed), in `currency`. null when no usable samples. */
  hourly: RateStats | null;
  median_hourly: number | null;
  /** Chronological per-submission £/hr samples (dominant currency) — feeds the sparkline. */
  hourly_series: number[];
  /** Median(actual duration ÷ estimated duration). >1 means studies run longer than advertised. null when no estimates. */
  duration_vs_estimate: number | null;
  duration_sample: number;
  reliability: ReliabilityScore;
}

export interface ResearcherStudyContext {
  /** Distinct studies observed from this researcher. */
  studies_posted: number;
  /** Median seconds a study stays listed (available → unavailable) — a fill/close-speed proxy. null when unknown. */
  median_listing_seconds: number | null;
  listing_sample: number;
}

export interface ResearcherProfile extends ResearcherMetrics {
  id: string;
  name: string;
  country: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  /** Study-history context. null for compact (submissions-only) profiles. */
  study: ResearcherStudyContext | null;
}

export interface ResearcherProfileInput {
  id: string;
  name?: string;
  researcher?: ResearcherRecord | null;
  submissions: SubmissionRecord[];
  studies?: Study[];
  availabilityEvents?: StudyAvailabilityEventRecord[];
}

// ──────────────────────────────────────────────────────────────
// Reliability
// ──────────────────────────────────────────────────────────────

export function computeReliability(counts: {
  approved: number;
  returned: number;
  rejected: number;
  screened_out: number;
}): ReliabilityScore {
  const decided = counts.approved + counts.returned + counts.rejected;
  const terminal = decided + counts.screened_out;
  const hasEnoughData = terminal >= RELIABILITY_MIN_TERMINAL;

  const a = FAIRNESS_PRIOR_MEAN * FAIRNESS_PRIOR_STRENGTH;
  const b = (1 - FAIRNESS_PRIOR_MEAN) * FAIRNESS_PRIOR_STRENGTH;
  const fairness = (counts.approved + a) / (decided + a + b);

  const screenRate = terminal > 0 ? counts.screened_out / terminal : 0;
  const screenScore = 1 - Math.min(1, screenRate / SCREEN_OUT_ZERO_AT);

  const score01 = FAIRNESS_WEIGHT * fairness + SCREEN_WEIGHT * screenScore;
  const score = Math.round(100 * score01);

  return { score, band: bandForScore(score, hasEnoughData), hasEnoughData };
}

function bandForScore(score: number, hasEnoughData: boolean): ReliabilityBand {
  if (!hasEnoughData) return 'unknown';
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'good';
  if (score >= 55) return 'fair';
  return 'poor';
}

const BAND_LABELS: Record<ReliabilityBand, string> = {
  excellent: 'Excellent',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Not enough history',
};

export function reliabilityBandLabel(band: ReliabilityBand): string {
  return BAND_LABELS[band];
}

const BAND_TEXT_CLASS: Record<ReliabilityBand, string> = {
  excellent: 'text-violet-600 dark:text-violet-400',
  good: 'text-emerald-600 dark:text-emerald-400',
  fair: 'text-amber-600 dark:text-amber-400',
  poor: 'text-rose-600 dark:text-rose-400',
  unknown: 'text-base-content/40',
};

export function reliabilityBandColorClass(band: ReliabilityBand): string {
  return BAND_TEXT_CLASS[band];
}

/** Look up a researcher's reliability from a compact-profiles map. null when the map/id is missing. */
export function reliabilityFor(
  profiles: Map<string, ResearcherProfile> | undefined,
  id: string | undefined | null,
): ReliabilityScore | null {
  if (!profiles || !id) return null;
  return profiles.get(id)?.reliability ?? null;
}

// ──────────────────────────────────────────────────────────────
// Submissions-only metrics
// ──────────────────────────────────────────────────────────────

export function computeResearcherMetrics(
  submissions: SubmissionRecord[],
  estimateMinutesForStudy?: (studyId: string) => number | null,
): ResearcherMetrics {
  const counts: ResearcherStatusCounts = {
    approved: 0,
    awaiting_review: 0,
    returned: 0,
    rejected: 0,
    screened_out: 0,
    other: 0,
  };
  for (const s of submissions) {
    if (s.phase !== 'submitted') continue;
    counts[categorizeStatus(s.status)]++;
  }

  const total = counts.approved + counts.awaiting_review + counts.returned + counts.rejected + counts.screened_out + counts.other;
  const terminal = counts.approved + counts.returned + counts.rejected + counts.screened_out;
  const decided = counts.approved + counts.returned + counts.rejected;
  const approval_rate = decided > 0 ? counts.approved / decided : null;
  const screened_out_rate = terminal > 0 ? counts.screened_out / terminal : null;

  const currency = detectDefaultCurrency(submissions) ?? '';

  const hourly_series = hourlySeries(submissions, currency);
  const hourly = hourly_series.length > 0 ? summarizeRates(hourly_series) : null;
  const median_hourly = hourly && Number.isFinite(hourly.median) ? hourly.median : null;

  const ratios = durationRatios(submissions, estimateMinutesForStudy);
  const duration_vs_estimate = ratios.length > 0 ? quantile(ratios, 0.5) : null;

  const reliability = computeReliability(counts);

  return {
    total,
    counts,
    terminal,
    decided,
    approval_rate,
    screened_out_rate,
    currency,
    hourly,
    median_hourly,
    hourly_series,
    duration_vs_estimate,
    duration_sample: ratios.length,
    reliability,
  };
}

/** Per-submission £/hr for the dominant currency, ordered oldest → newest. */
function hourlySeries(submissions: SubmissionRecord[], currency: string): number[] {
  const timed = submissions
    .filter((s) => s.phase === 'submitted')
    .map((s) => ({ s, t: recordEventTime(s) }))
    .filter((x): x is { s: SubmissionRecord; t: Date } => x.t !== null)
    .sort((a, b) => a.t.getTime() - b.t.getTime());

  const out: number[] = [];
  for (const { s } of timed) {
    const reward = extractSubmissionReward(s);
    if (!reward) continue;
    if (currency && reward.currency !== currency) continue;
    const h = perSubmissionHourly(s);
    if (h !== null && Number.isFinite(h)) out.push(h);
  }
  return out;
}

/** Sorted actual/estimate duration ratios across submissions with both figures. */
function durationRatios(
  submissions: SubmissionRecord[],
  estimateMinutesForStudy?: (studyId: string) => number | null,
): number[] {
  const ratios: number[] = [];
  for (const s of submissions) {
    if (s.phase !== 'submitted') continue;
    const actual = extractDurationSeconds(s);
    if (actual === null) continue;
    // Prefer the observed study's estimate (from studiesLatest); fall back to any estimate carried
    // on the submission payload itself (present on some Prolific submission responses).
    const estMin = estimateMinutesForStudy?.(s.study_id) || estimateMinutesFromPayload(s);
    if (!estMin || estMin <= 0) continue;
    const ratio = actual / (estMin * 60);
    if (Number.isFinite(ratio) && ratio > 0) ratios.push(ratio);
  }
  ratios.sort((a, b) => a - b);
  return ratios;
}

/** Study time estimate (minutes) carried on a submission payload, if any. */
function estimateMinutesFromPayload(s: SubmissionRecord): number | null {
  const p = s.payload as Record<string, unknown> | undefined;
  const study = p?.study as Record<string, unknown> | undefined;
  const est = Number(study?.estimated_completion_time);
  return Number.isFinite(est) && est > 0 ? est : null;
}

// ──────────────────────────────────────────────────────────────
// Study-history context (fill / listing speed)
// ──────────────────────────────────────────────────────────────

export function computeStudyContext(
  studies: Study[],
  events: StudyAvailabilityEventRecord[],
): ResearcherStudyContext {
  const studyIds = new Set(studies.map((s) => s.id).filter(Boolean));

  const byStudy = new Map<string, StudyAvailabilityEventRecord[]>();
  for (const e of events) {
    if (!studyIds.has(e.study_id)) continue;
    const list = byStudy.get(e.study_id);
    if (list) list.push(e);
    else byStudy.set(e.study_id, [e]);
  }

  const durations: number[] = [];
  for (const evs of byStudy.values()) {
    const secs = firstListingDurationSeconds(evs);
    if (secs !== null) durations.push(secs);
  }
  durations.sort((a, b) => a - b);

  return {
    studies_posted: studyIds.size,
    median_listing_seconds: durations.length > 0 ? quantile(durations, 0.5) : null,
    listing_sample: durations.length,
  };
}

// ──────────────────────────────────────────────────────────────
// Full + compact profiles
// ──────────────────────────────────────────────────────────────

export function computeResearcherProfile(input: ResearcherProfileInput): ResearcherProfile {
  const studies = input.studies ?? [];
  const estimateMap = buildEstimateMap(studies);
  const metrics = computeResearcherMetrics(
    input.submissions,
    estimateMap.size > 0 ? (id) => estimateMap.get(id) ?? null : undefined,
  );

  const study = input.studies !== undefined || input.availabilityEvents !== undefined
    ? computeStudyContext(studies, input.availabilityEvents ?? [])
    : null;

  const rec = input.researcher;
  const fallback = firstResearcherIdentity(input.submissions);
  // A caller that only knows the id may pass it as the name (e.g. a study missing the researcher
  // name); treat that as "no name" so the record / past submissions can supply the real one.
  const provided = trimString(input.name);
  const name = (provided && provided !== input.id ? provided : '')
    || trimString(rec?.name) || fallback.name || input.id;
  const country = trimString(rec?.country) || fallback.country || '';

  const seen = observedRange(input.submissions);
  const first_seen_at = rec?.first_seen_at || seen.first || null;
  const last_seen_at = rec?.last_seen_at || seen.last || null;

  return { id: input.id, name, country, first_seen_at, last_seen_at, study, ...metrics };
}

/** Group submissions by researcher and build a submissions-only profile for each (for the picker). */
export function computeCompactProfiles(submissions: SubmissionRecord[]): Map<string, ResearcherProfile> {
  const groups = new Map<string, { name: string; subs: SubmissionRecord[] }>();
  for (const s of submissions) {
    const ref = researcherRefFromPayload(s.payload);
    if (!ref?.id) continue;
    const g = groups.get(ref.id);
    if (g) {
      g.subs.push(s);
      if (!g.name && ref.name) g.name = ref.name;
    } else {
      groups.set(ref.id, { name: ref.name, subs: [s] });
    }
  }

  const out = new Map<string, ResearcherProfile>();
  for (const [id, { name, subs }] of groups) {
    out.set(id, computeResearcherProfile({ id, name, submissions: subs }));
  }
  return out;
}

function buildEstimateMap(studies: Study[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const s of studies) {
    const est = Number(s.estimated_completion_time);
    if (s.id && Number.isFinite(est) && est > 0) map.set(s.id, est);
  }
  return map;
}

function firstResearcherIdentity(submissions: SubmissionRecord[]): { name: string; country: string } {
  let name = '';
  let country = '';
  for (const s of submissions) {
    const ref = researcherRefFromPayload(s.payload);
    if (!ref) continue;
    if (!name && ref.name) name = ref.name;
    if (!country && ref.country) country = ref.country;
    if (name && country) break;
  }
  return { name, country };
}

function observedRange(submissions: SubmissionRecord[]): { first: string | null; last: string | null } {
  let first: string | null = null;
  let last: string | null = null;
  for (const s of submissions) {
    const at = s.observed_at;
    if (!at) continue;
    if (first === null || at < first) first = at;
    if (last === null || at > last) last = at;
  }
  return { first, last };
}
