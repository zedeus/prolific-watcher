import type { StudyHistoryRecord, StudyAvailabilityEventRecord } from './db';
import type { Money } from './types';
import { parseDate, trimString } from './format';
import { quantile, mean } from './earnings';
import { RELIABLE_OBSERVATION_GAP_MS } from './constants';

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
// Observation continuity
//
// Availability events are only meaningful when Pulse was actually watching across a study's life. Used
// sporadically, the extension stamps `unavailable` the moment it *next* runs and sees a study gone —
// which can be days after it really closed — so the raw listing duration is noise, not a fill time.
// studiesHistory records one row per observed study per refresh, so its timestamps ARE the observation
// timeline. We reconstruct continuity from it (works on already-recorded data, no schema change) and
// drop any interval/event whose surrounding observation gap is too large to trust.
//
// Two known limits of reconstructing the timeline from studiesHistory, both CONSERVATIVE (they drop
// real samples, never invent bad ones): (1) an empty-feed refresh writes no history row, and (2)
// retention compaction thins dense interior observations over time. Both can make the *global*
// timeline (used by the appearance check → posting cadence AND rerun detection) look gappier than it
// was, so old postings / reappearances may be under-counted. The close check (fill speed, "typically
// listed") uses each study's
// own last-before-close observation, which compaction keeps as an endpoint, so it stays accurate. A
// durable per-refresh heartbeat store would make the appearance side exact — deferred; today it
// degrades gracefully. `sparse` is keyed on the close side so this never triggers a false warning.
// ──────────────────────────────────────────────────────────────

export interface Observations {
  /** Sorted epoch-ms of every distinct moment any study was observed. */
  all: number[];
  /** Sorted epoch-ms per study. */
  byStudy: Map<string, number[]>;
}

export function buildObservations(history: StudyHistoryRecord[]): Observations {
  const all = new Set<number>();
  const byStudy = new Map<string, number[]>();
  for (const row of history) {
    const t = parseDate(row.observed_at)?.getTime();
    if (t === undefined) continue;
    all.add(t);
    const id = trimString(row.study_id);
    if (!id) continue;
    const list = byStudy.get(id);
    if (list) list.push(t);
    else byStudy.set(id, [t]);
  }
  const allSorted = [...all].sort((a, b) => a - b);
  for (const list of byStudy.values()) list.sort((a, b) => a - b);
  return { all: allSorted, byStudy };
}

/** Count of elements before `t` (strictly, or ≤ when inclusive) in a sorted array — binary search. */
function boundIndex(sorted: number[], t: number, inclusive: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inclusive ? sorted[mid] <= t : sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Gap (ms) from `t` back to the nearest observation strictly before it; Infinity if there is none. */
function gapBefore(sorted: number[], t: number): number {
  const i = boundIndex(sorted, t, false);
  return i === 0 ? Infinity : t - sorted[i - 1];
}

/** Largest observation ≤ `t`, or null if none. */
function lastAtOrBefore(sorted: number[], t: number): number | null {
  const i = boundIndex(sorted, t, true);
  return i === 0 ? null : sorted[i - 1];
}

/** Were we watching just before this study went available (so its "drop" time is real)? */
function appearanceObserved(obs: Observations, availableAtMs: number): boolean {
  return gapBefore(obs.all, availableAtMs) <= RELIABLE_OBSERVATION_GAP_MS;
}

/** Did we watch this study right up to its close (so its listing duration is real)? */
function closeObserved(obs: Observations, studyId: string, unavailableAtMs: number): boolean {
  const last = lastAtOrBefore(obs.byStudy.get(studyId) ?? [], unavailableAtMs);
  return last !== null && unavailableAtMs - last <= RELIABLE_OBSERVATION_GAP_MS;
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

// ──────────────────────────────────────────────────────────────
// Fill speed
// ──────────────────────────────────────────────────────────────

export interface FillSpeedStats {
  /** Median/quartile of each study's first reliably-watched close duration (seconds). null when no sample. */
  median_seconds: number | null;
  p25_seconds: number | null;
  p75_seconds: number | null;
  /** Studies contributing a reliable closed listing duration. */
  sample: number;
  /** Closed listings dropped because Pulse wasn't watching across them (observation gaps). */
  skipped_unreliable: number;
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

interface StudyClose {
  study_id: string;
  unavailable_at: Date;
  duration_seconds: number;
}

/**
 * The first *trustworthy* closed listing per study, plus a count of studies whose closes we couldn't
 * trust. A listing duration is trustworthy when we watched the study right up to its close — its last
 * seen-present observation is within RELIABLE_OBSERVATION_GAP_MS of the `unavailable` event. If instead
 * it was marked unavailable long after we last saw it (Pulse wasn't running), the duration is really
 * the gap between sessions (the "161h" bug), so it's dropped.
 *
 * We take the first *reliable* close (not the first close then a check): a study that appeared while
 * Pulse was away but was watched to its close on a later listing still contributes a real sample. The
 * close side uses only each study's own observations, whose last-before-close survives compaction as an
 * endpoint. (The appearance side, used by posting cadence + rerun detection, needs the global timeline —
 * see the module note on how that degrades as history is compacted.) No `observations` → every close is
 * reliable.
 */
function reliableCloses(
  intervals: Map<string, ListingInterval[]>,
  observations?: Observations,
): { reliable: StudyClose[]; skipped: number } {
  const reliable: StudyClose[] = [];
  let skipped = 0;
  for (const [studyId, list] of intervals) {
    const closed = list.filter((i): i is ListingInterval & { unavailable_at: Date; duration_seconds: number } =>
      i.duration_seconds !== null && i.unavailable_at !== null);
    if (closed.length === 0) continue; // still live / never closed — not a fill sample either way
    const pick = observations
      ? closed.find((i) => closeObserved(observations, studyId, i.unavailable_at.getTime()))
      : closed[0];
    if (pick) reliable.push({ study_id: studyId, unavailable_at: pick.unavailable_at, duration_seconds: pick.duration_seconds });
    else skipped += 1;
  }
  return { reliable, skipped };
}

/**
 * First-reliable-close listing durations (seconds) across the given events. Shared with
 * researcher-profile.ts so its "typically listed" figure uses the same observation-aware definition as
 * the Insights fill-speed view. No `observations` → no filtering.
 */
export function reliableListingSeconds(
  events: StudyAvailabilityEventRecord[],
  observations?: Observations,
): number[] {
  return reliableCloses(listingIntervalsByStudy(events), observations).reliable.map((c) => c.duration_seconds);
}

export function computeFillSpeed(
  events: StudyAvailabilityEventRecord[],
  observations?: Observations,
): FillSpeedStats {
  const intervals = listingIntervalsByStudy(events);
  const { reliable, skipped } = reliableCloses(intervals, observations);
  const durations = reliable.map((c) => c.duration_seconds).sort((a, b) => a - b);
  return {
    median_seconds: durations.length > 0 ? quantile(durations, 0.5) : null,
    p25_seconds: durations.length > 0 ? quantile(durations, 0.25) : null,
    p75_seconds: durations.length > 0 ? quantile(durations, 0.75) : null,
    sample: durations.length,
    skipped_unreliable: skipped,
    studies_tracked: intervals.size,
  };
}

/** Studies that filled/closed fastest, ascending by listing duration. Names/researchers from `meta`. */
export function fastestFillingStudies(
  events: StudyAvailabilityEventRecord[],
  meta: Map<string, StudyMeta> | undefined,
  limit = 5,
  observations?: Observations,
): FilledStudy[] {
  const nameFallback = studyNameFallback(events);
  const { reliable } = reliableCloses(listingIntervalsByStudy(events), observations);
  reliable.sort((a, b) => a.duration_seconds - b.duration_seconds || a.study_id.localeCompare(b.study_id));
  return reliable.slice(0, Math.max(0, limit)).map((c) => {
    const m = metaFor(meta, c.study_id, nameFallback.get(c.study_id) ?? '');
    return {
      study_id: c.study_id,
      study_name: m.name,
      researcher_id: m.researcher_id,
      researcher_name: m.researcher_name,
      duration_seconds: c.duration_seconds,
      closed_at: c.unavailable_at.toISOString(),
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
  /** `available` events dropped because Pulse wasn't watching just before them (so the drop time is unknown). */
  skipped_unreliable: number;
  /** Hour with the most postings, null when there's no data. */
  peak_hour: number | null;
  peak_dow: number | null;
}

/**
 * When new studies appear, from `available` events in local time — "best times to be online". Each
 * `available` event is one study going live (a posting). With `observations`, only events we actually
 * watched drop are counted: a study that was already listed when Pulse started, or appeared during a
 * gap, has an unknown drop time, so it's excluded rather than pinned to "when I opened the extension".
 */
export function computePostingCadence(
  events: StudyAvailabilityEventRecord[],
  observations?: Observations,
): PostingCadence {
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const byDow = Array.from({ length: 7 }, (_, dow) => ({ dow, count: 0 }));
  let total = 0;
  let skipped = 0;
  for (const e of events) {
    if (e.event_type !== 'available') continue;
    const at = parseDate(e.observed_at);
    if (!at) continue;
    if (observations && !appearanceObserved(observations, at.getTime())) {
      skipped += 1;
      continue;
    }
    byHour[at.getHours()].count += 1;
    byDow[at.getDay()].count += 1;
    total += 1;
  }
  return {
    by_hour: byHour,
    by_dow: byDow,
    total_postings: total,
    skipped_unreliable: skipped,
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
  observations?: Observations,
): Rerun[] {
  const intervals = listingIntervalsByStudy(events);
  const nameFallback = studyNameFallback(events);
  const out: Rerun[] = [];
  for (const [studyId, list] of intervals) {
    // Only appearances we actually watched drop — a reappearance seen only after a long gap has an
    // unknown real time and would fabricate a cadence.
    const starts = list
      .map((i) => i.available_at.getTime())
      .filter((t) => !observations || appearanceObserved(observations, t))
      .sort((a, b) => a - b);
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

export interface InsightsDataQuality {
  /**
   * Closed listings existed but their durations were mostly untrustworthy — studies changed while Pulse
   * wasn't watching (the "161h" case). Drives the "keep Pulse running" note. Per-section skip counts
   * live on `fill_speed.skipped_unreliable` / `posting.skipped_unreliable`.
   */
  sparse: boolean;
}

export interface StudyHistoryInsights {
  price_changes: PriceChange[];
  fill_speed: FillSpeedStats;
  fastest_filling: FilledStudy[];
  posting: PostingCadence;
  reruns: Rerun[];
  data_quality: InsightsDataQuality;
  history_count: number;
  events_count: number;
  /** True when there's genuinely nothing to analyse yet (no usable data of any kind). */
  empty: boolean;
}

/** Compute the whole Insights view-model in one pass. Meta + observation timeline built once, shared. */
export function computeStudyHistoryInsights(
  history: StudyHistoryRecord[],
  events: StudyAvailabilityEventRecord[],
  opts: StudyHistoryInsightsOptions = {},
): StudyHistoryInsights {
  const meta = buildStudyMeta(history);
  const observations = buildObservations(history);
  const price_changes = computePriceChanges(history);
  const fill_speed = computeFillSpeed(events, observations);
  const fastest_filling = fastestFillingStudies(events, meta, opts.fastestLimit ?? 5, observations);
  const posting = computePostingCadence(events, observations);
  const reruns = detectReruns(events, meta, 2, observations);

  // "Sparse" keys on the CLOSE side only: we had closed listings but couldn't trust their durations
  // because studies changed while Pulse wasn't watching (the "161h" case). Deliberately ignores
  // posting skips — a brand-new user's studies are excluded as "already listed when watching began",
  // which is normal, not a gap, and must not trigger the "your history has gaps" warning.
  const sparse = fill_speed.skipped_unreliable > fill_speed.sample;

  return {
    price_changes,
    fill_speed,
    fastest_filling,
    posting,
    reruns,
    data_quality: { sparse },
    history_count: history.length,
    events_count: events.length,
    empty:
      price_changes.length === 0 &&
      fill_speed.sample === 0 &&
      fill_speed.skipped_unreliable === 0 &&
      posting.total_postings === 0 &&
      reruns.length === 0,
  };
}
