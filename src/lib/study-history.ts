import type { StudyHistoryRecord, StudyAvailabilityEventRecord } from './db';
import type { Money } from './types';
import { parseDate, trimString } from './format';
import { quantile, mean } from './earnings';

// ──────────────────────────────────────────────────────────────
// Study-history analytics
//
// Two raw sources feed this module, both recorded by the background ingest path:
//   • studiesHistory        — a full study snapshot every refresh (payload.reward etc.). The only
//                             place reward/price movement lives (availability events carry no reward).
//   • studyAvailabilityEvents — available/unavailable transitions. Feeds fill speed, posting cadence,
//                             and rerun detection.
// Everything here is pure (no DB) so it unit-tests cleanly and can run in the popup over the arrays
// the store hands it. The listing-interval primitive is shared with researcher-profile.ts (#18) so
// fill-speed logic lives in one place.
// ──────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────
// Study metadata (name + researcher), joined onto event-based analyses
// ──────────────────────────────────────────────────────────────

export interface StudyMeta {
  name: string;
  researcher_id: string;
  researcher_name: string;
}

/**
 * Build a `study_id → {name, researcher}` map from history snapshots. The latest snapshot per study
 * wins (names/researchers are stable, but a later snapshot is the freshest identity). Availability
 * events carry a study name but no researcher, so this is how event-based views (fastest fillers,
 * reruns) attribute a researcher.
 */
export function buildStudyMeta(history: StudyHistoryRecord[]): Map<string, StudyMeta> {
  const latestAt = new Map<string, string>();
  const meta = new Map<string, StudyMeta>();
  for (const row of history) {
    const id = trimString(row.study_id);
    if (!id) continue;
    const prevAt = latestAt.get(id);
    if (prevAt !== undefined && row.observed_at <= prevAt) continue;
    latestAt.set(id, row.observed_at);
    const p = row.payload as Record<string, unknown> | undefined;
    const researcher = p?.researcher as Record<string, unknown> | undefined;
    meta.set(id, {
      name: trimString(p?.name),
      researcher_id: trimString(researcher?.id),
      researcher_name: trimString(researcher?.name),
    });
  }
  return meta;
}

function metaFor(meta: Map<string, StudyMeta> | undefined, studyId: string, fallbackName: string): StudyMeta {
  const m = meta?.get(studyId);
  return {
    name: m?.name || fallbackName || studyId,
    researcher_id: m?.researcher_id ?? '',
    researcher_name: m?.researcher_name ?? '',
  };
}

/** Bucket rows by their (trimmed, non-empty) study_id, preserving input order within each bucket. */
function groupByStudyId<T extends { study_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const id = trimString(r.study_id);
    if (!id) continue;
    const list = out.get(id);
    if (list) list.push(r);
    else out.set(id, [r]);
  }
  return out;
}

/** Ascending comparator on the ISO `observed_at` string (chronological for same-format timestamps). */
function byObservedAt(a: { observed_at: string }, b: { observed_at: string }): number {
  return a.observed_at.localeCompare(b.observed_at);
}

// ──────────────────────────────────────────────────────────────
// Listing intervals (shared fill-speed primitive)
// ──────────────────────────────────────────────────────────────

export interface ListingInterval {
  study_id: string;
  available_at: Date;
  /** null while a study is still listed (available with no later unavailable). */
  unavailable_at: Date | null;
  /** null while still listed. */
  duration_seconds: number | null;
}

/**
 * Pair up available→unavailable events per study into listing intervals. A study can be listed more
 * than once (it went away then came back), so this returns every cycle in order — that same signal
 * powers rerun detection. Tolerant of the messy real feed: orphan `unavailable`s (no open interval),
 * duplicate `available`s (keep the first), unparseable timestamps (skipped), and out-of-order rows.
 */
export function listingIntervalsByStudy(
  events: StudyAvailabilityEventRecord[],
): Map<string, ListingInterval[]> {
  const out = new Map<string, ListingInterval[]>();
  for (const [studyId, evs] of groupByStudyId(events)) {
    const sorted = [...evs].sort(byObservedAt);
    const intervals: ListingInterval[] = [];
    let openAt: Date | null = null;
    for (const e of sorted) {
      if (e.event_type === 'available') {
        if (openAt) continue; // duplicate available while already open — keep the first
        openAt = parseDate(e.observed_at);
      } else if (e.event_type === 'unavailable') {
        if (!openAt) continue; // orphan unavailable
        const closedAt = parseDate(e.observed_at);
        const secs = closedAt ? (closedAt.getTime() - openAt.getTime()) / 1000 : null;
        intervals.push({
          study_id: studyId,
          available_at: openAt,
          unavailable_at: closedAt,
          duration_seconds: secs !== null && secs > 0 ? secs : null,
        });
        openAt = null;
      }
    }
    if (openAt) {
      intervals.push({ study_id: studyId, available_at: openAt, unavailable_at: null, duration_seconds: null });
    }
    out.set(studyId, intervals);
  }
  return out;
}

/**
 * Seconds a study stayed listed on its first closed cycle (available → next unavailable), or null if
 * it never closed / can't be parsed. Shared with researcher-profile.ts so the per-researcher
 * fill-speed proxy and the Insights view agree.
 */
export function firstListingDurationSeconds(events: StudyAvailabilityEventRecord[]): number | null {
  // The study's FIRST listing cycle only (matches the researcher-profile behaviour this replaced): a
  // still-open or bad-timestamp first close yields null rather than skipping ahead to a later cycle.
  const intervals = listingIntervalsByStudy(events).get(trimString(events[0]?.study_id)) ?? [];
  return intervals[0]?.duration_seconds ?? null;
}

// ──────────────────────────────────────────────────────────────
// Fill speed
// ──────────────────────────────────────────────────────────────

export interface FillSpeedStats {
  /** Median/quartile of each study's first-close listing duration (seconds). null when no sample. */
  median_seconds: number | null;
  p25_seconds: number | null;
  p75_seconds: number | null;
  /** Studies contributing a closed listing duration. */
  sample: number;
  /** Distinct studies with at least one `available` event. */
  studies_tracked: number;
}

export interface FilledStudy {
  study_id: string;
  study_name: string;
  researcher_id: string;
  researcher_name: string;
  duration_seconds: number;
  closed_at: string;
}

interface StudyFirstClose {
  study_id: string;
  duration_seconds: number;
  closed_at: string;
}

/** One entry per study that has a closed first listing: its duration + close time. */
function firstCloses(intervals: Map<string, ListingInterval[]>): StudyFirstClose[] {
  const out: StudyFirstClose[] = [];
  for (const [studyId, list] of intervals) {
    for (const i of list) {
      if (i.duration_seconds !== null && i.unavailable_at) {
        out.push({ study_id: studyId, duration_seconds: i.duration_seconds, closed_at: i.unavailable_at.toISOString() });
        break;
      }
    }
  }
  return out;
}

export function computeFillSpeed(events: StudyAvailabilityEventRecord[]): FillSpeedStats {
  const intervals = listingIntervalsByStudy(events);
  const durations = firstCloses(intervals).map((c) => c.duration_seconds).sort((a, b) => a - b);
  return {
    median_seconds: durations.length > 0 ? quantile(durations, 0.5) : null,
    p25_seconds: durations.length > 0 ? quantile(durations, 0.25) : null,
    p75_seconds: durations.length > 0 ? quantile(durations, 0.75) : null,
    sample: durations.length,
    studies_tracked: intervals.size,
  };
}

/** Studies that filled/closed fastest, ascending by listing duration. Names/researchers from `meta`. */
export function fastestFillingStudies(
  events: StudyAvailabilityEventRecord[],
  meta: Map<string, StudyMeta> | undefined,
  limit = 5,
): FilledStudy[] {
  const nameFallback = studyNameFallback(events);
  const closes = firstCloses(listingIntervalsByStudy(events));
  closes.sort((a, b) => a.duration_seconds - b.duration_seconds || a.study_id.localeCompare(b.study_id));
  return closes.slice(0, Math.max(0, limit)).map((c) => {
    const m = metaFor(meta, c.study_id, nameFallback.get(c.study_id) ?? '');
    return {
      study_id: c.study_id,
      study_name: m.name,
      researcher_id: m.researcher_id,
      researcher_name: m.researcher_name,
      duration_seconds: c.duration_seconds,
      closed_at: c.closed_at,
    };
  });
}

/** study_id → most recent study_name seen on its events (fallback when history meta is missing). */
function studyNameFallback(events: StudyAvailabilityEventRecord[]): Map<string, string> {
  const seen = new Map<string, { name: string; at: string }>();
  for (const e of events) {
    const id = trimString(e.study_id);
    if (!id) continue;
    const name = trimString(e.study_name);
    const prev = seen.get(id);
    if (!prev || e.observed_at >= prev.at) seen.set(id, { name: name || prev?.name || '', at: e.observed_at });
  }
  const out = new Map<string, string>();
  for (const [id, v] of seen) out.set(id, v.name);
  return out;
}

// ──────────────────────────────────────────────────────────────
// Price / reward movement (from studiesHistory)
// ──────────────────────────────────────────────────────────────

function extractRewardMinor(payload: Record<string, unknown> | undefined, field: string): Money | null {
  const r = payload?.[field] as Record<string, unknown> | undefined;
  if (!r || typeof r !== 'object') return null;
  const amount = Number(r.amount);
  const currency = String(r.currency ?? '').toUpperCase();
  if (!Number.isFinite(amount) || amount < 0 || !currency) return null;
  return { amount, currency };
}

export type PriceDirection = 'up' | 'down';

export interface PriceChange {
  study_id: string;
  study_name: string;
  researcher_id: string;
  researcher_name: string;
  currency: string;
  first_reward_minor: number;
  last_reward_minor: number;
  /** last − first (minor units). Sign matches `direction`. */
  delta_minor: number;
  /** delta / first (fraction; 0.2 = +20%). */
  pct: number;
  direction: PriceDirection;
  /** observed_at of the snapshot where the reward last differed from the one before it. */
  changed_at: string;
}

/**
 * Detect studies whose reward moved across their history snapshots — the "researcher bumped (or cut)
 * the pay" signal. One entry per study whose reward changed at least once, classified up/down by
 * first-vs-last. Only the study's first-seen currency is considered (a currency flip is ignored, not
 * treated as a price move). Sorted most-recently-changed first.
 */
export function computePriceChanges(history: StudyHistoryRecord[]): PriceChange[] {
  const out: PriceChange[] = [];
  for (const [studyId, rows] of groupByStudyId(history)) {
    const sorted = [...rows].sort(byObservedAt);
    let currency = '';
    let first: number | null = null;
    let last = 0;
    let min = 0;
    let max = 0;
    let prev: number | null = null;
    let changedAt = '';
    let lastPayload: Record<string, unknown> | undefined;

    for (const row of sorted) {
      const p = row.payload as Record<string, unknown> | undefined;
      const reward = extractRewardMinor(p, 'reward');
      if (!reward) continue;
      if (first === null) {
        currency = reward.currency;
        first = reward.amount;
        min = reward.amount;
        max = reward.amount;
      } else if (reward.currency !== currency) {
        continue; // ignore currency flips
      }
      last = reward.amount;
      lastPayload = p;
      if (reward.amount < min) min = reward.amount;
      if (reward.amount > max) max = reward.amount;
      if (prev !== null && reward.amount !== prev) changedAt = row.observed_at;
      prev = reward.amount;
    }

    if (first === null || max === min) continue; // never had a usable reward, or it never moved
    const delta = last - first;
    // A study can wobble and return to its first value (last === first) yet still have moved
    // (max !== min); treat the net direction by max deviation in that case.
    const direction: PriceDirection = delta !== 0
      ? (delta > 0 ? 'up' : 'down')
      : (max - first >= first - min ? 'up' : 'down');
    const researcher = lastPayload?.researcher as Record<string, unknown> | undefined;
    out.push({
      study_id: studyId,
      study_name: trimString(lastPayload?.name) || studyId,
      researcher_id: trimString(researcher?.id),
      researcher_name: trimString(researcher?.name),
      currency,
      first_reward_minor: first,
      last_reward_minor: last,
      delta_minor: delta,
      pct: first > 0 ? delta / first : 0,
      direction,
      changed_at: changedAt || sorted[sorted.length - 1].observed_at,
    });
  }

  out.sort((a, b) => b.changed_at.localeCompare(a.changed_at) || a.study_id.localeCompare(b.study_id));
  return out;
}

// ──────────────────────────────────────────────────────────────
// Posting cadence (best times to be online)
// ──────────────────────────────────────────────────────────────

export interface PostingHourBucket {
  hour: number; // 0..23 local
  count: number;
}

export interface PostingDowBucket {
  dow: number; // 0=Sun..6=Sat local
  count: number;
}

export interface PostingCadence {
  by_hour: PostingHourBucket[]; // length 24
  by_dow: PostingDowBucket[]; // length 7
  total_postings: number;
  /** Hour with the most postings, null when there's no data. */
  peak_hour: number | null;
  peak_dow: number | null;
}

/**
 * When new studies appear, from `available` events in local time — "best times to be online". Each
 * `available` event is one study going live (a posting).
 */
export function computePostingCadence(events: StudyAvailabilityEventRecord[]): PostingCadence {
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const byDow = Array.from({ length: 7 }, (_, dow) => ({ dow, count: 0 }));
  let total = 0;
  for (const e of events) {
    if (e.event_type !== 'available') continue;
    const at = parseDate(e.observed_at);
    if (!at) continue;
    byHour[at.getHours()].count += 1;
    byDow[at.getDay()].count += 1;
    total += 1;
  }
  return {
    by_hour: byHour,
    by_dow: byDow,
    total_postings: total,
    peak_hour: total > 0 ? peakIndex(byHour.map((b) => b.count)) : null,
    peak_dow: total > 0 ? peakIndex(byDow.map((b) => b.count)) : null,
  };
}

function peakIndex(counts: number[]): number {
  let best = 0;
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > counts[best]) best = i;
  }
  return best;
}

// ──────────────────────────────────────────────────────────────
// Rerun detection (studies reposted on a schedule)
// ──────────────────────────────────────────────────────────────

export interface Rerun {
  study_id: string;
  study_name: string;
  researcher_id: string;
  researcher_name: string;
  /** How many times the study went available (i.e. distinct listings). */
  appearances: number;
  /** Median gap between successive availabilities (seconds). */
  median_gap_seconds: number;
  last_available_at: string;
  /** last_available_at + median gap — a naive "next repost" estimate. */
  next_expected_at: string;
  /** Gaps are consistent enough (low spread, ≥3 appearances) to look scheduled. */
  regular: boolean;
}

/** Gaps consistent to within this coefficient of variation count as "scheduled". */
export const RERUN_REGULAR_CV = 0.35;

/**
 * Studies that were listed more than once — reposts. Cadence is the median gap between successive
 * availabilities; a study is flagged `regular` when those gaps are consistent (looks scheduled).
 * Sorted most appearances first, then soonest next-expected.
 */
export function detectReruns(
  events: StudyAvailabilityEventRecord[],
  meta: Map<string, StudyMeta> | undefined,
  minAppearances = 2,
): Rerun[] {
  const intervals = listingIntervalsByStudy(events);
  const nameFallback = studyNameFallback(events);
  const out: Rerun[] = [];
  for (const [studyId, list] of intervals) {
    const starts = list.map((i) => i.available_at.getTime()).sort((a, b) => a - b);
    if (starts.length < minAppearances) continue;
    const gaps: number[] = [];
    for (let i = 1; i < starts.length; i++) gaps.push((starts[i] - starts[i - 1]) / 1000);
    if (gaps.length === 0) continue;
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const median = quantile(sortedGaps, 0.5);
    const lastAt = starts[starts.length - 1];
    const m = metaFor(meta, studyId, nameFallback.get(studyId) ?? '');
    out.push({
      study_id: studyId,
      study_name: m.name,
      researcher_id: m.researcher_id,
      researcher_name: m.researcher_name,
      appearances: starts.length,
      median_gap_seconds: median,
      last_available_at: new Date(lastAt).toISOString(),
      next_expected_at: new Date(lastAt + median * 1000).toISOString(),
      regular: starts.length >= 3 && median > 0 && coefficientOfVariation(gaps) <= RERUN_REGULAR_CV,
    });
  }
  out.sort((a, b) => b.appearances - a.appearances || a.next_expected_at.localeCompare(b.next_expected_at));
  return out;
}

function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return Infinity;
  const m = mean(values);
  if (m <= 0) return Infinity;
  const variance = values.reduce((a, b) => a + (b - m) * (b - m), 0) / values.length;
  return Math.sqrt(variance) / m;
}

// ──────────────────────────────────────────────────────────────
// Retention: redundant-snapshot compaction
// ──────────────────────────────────────────────────────────────

/**
 * The fields we care about analytically: reward and hourly rate (the price-movement signal). A run of
 * consecutive snapshots with an identical signature carries no extra signal beyond its two endpoints,
 * so the interior rows are safe to prune. Deliberately excludes `places_available` — it ticks down on
 * nearly every refresh of an actively-filling study, and no analytic reads it from history (fill speed
 * comes from availability events), so including it would defeat compaction for exactly the busy studies
 * that generate the most rows.
 */
function analyticSignature(payload: Record<string, unknown> | undefined): string {
  const reward = extractRewardMinor(payload, 'reward');
  const hourly = extractRewardMinor(payload, 'average_reward_per_hour');
  return [
    reward ? `${reward.amount}|${reward.currency}` : '_',
    hourly ? `${hourly.amount}` : '_',
  ].join('~');
}

/**
 * Row ids of studiesHistory snapshots that are safe to delete: strictly-interior duplicates of a run
 * where the reward / hourly / places didn't change from the neighbour before AND after. Every
 * change-point and each study's first & last snapshot are always kept, so price-movement, fill-speed
 * and rerun analysis are byte-for-byte unaffected — this only collapses the unbounded "same study,
 * unchanged, re-observed every refresh" growth.
 */
export function redundantHistoryRowIds(history: StudyHistoryRecord[]): number[] {
  const byStudy = groupByStudyId(history.filter((r) => r.row_id !== undefined));

  const drop: number[] = [];
  for (const rows of byStudy.values()) {
    if (rows.length < 3) continue;
    const sorted = [...rows].sort(byObservedAt);
    const sigs = sorted.map((r) => analyticSignature(r.payload as Record<string, unknown> | undefined));
    for (let i = 1; i < sorted.length - 1; i++) {
      if (sigs[i] === sigs[i - 1] && sigs[i] === sigs[i + 1]) {
        drop.push(sorted[i].row_id as number);
      }
    }
  }
  return drop;
}

// ──────────────────────────────────────────────────────────────
// Top-level bundle
// ──────────────────────────────────────────────────────────────

export interface StudyHistoryInsightsOptions {
  fastestLimit?: number;
}

export interface StudyHistoryInsights {
  price_changes: PriceChange[];
  fill_speed: FillSpeedStats;
  fastest_filling: FilledStudy[];
  posting: PostingCadence;
  reruns: Rerun[];
  history_count: number;
  events_count: number;
  /** True when there's essentially nothing to analyse yet. */
  empty: boolean;
}

/** Compute the whole Insights view-model in one pass. Meta is built once and shared. */
export function computeStudyHistoryInsights(
  history: StudyHistoryRecord[],
  events: StudyAvailabilityEventRecord[],
  opts: StudyHistoryInsightsOptions = {},
): StudyHistoryInsights {
  const meta = buildStudyMeta(history);
  const price_changes = computePriceChanges(history);
  const fill_speed = computeFillSpeed(events);
  const fastest_filling = fastestFillingStudies(events, meta, opts.fastestLimit ?? 5);
  const posting = computePostingCadence(events);
  const reruns = detectReruns(events, meta);
  return {
    price_changes,
    fill_speed,
    fastest_filling,
    posting,
    reruns,
    history_count: history.length,
    events_count: events.length,
    empty:
      price_changes.length === 0 &&
      fill_speed.sample === 0 &&
      posting.total_postings === 0 &&
      reruns.length === 0,
  };
}
