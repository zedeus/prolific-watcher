import { describe, it, expect } from 'vitest';
import type { StudyHistoryRecord, StudyAvailabilityEventRecord } from '../db';
import {
  buildStudyMeta,
  listingIntervalsByStudy,
  computeFillSpeed,
  fastestFillingStudies,
  computePriceChanges,
  computePostingCadence,
  detectReruns,
  redundantHistoryRowIds,
  computeStudyHistoryInsights,
  buildObservations,
} from '../study-history';

// ──────────────────────────────────────────────────────────────
// Builders
// ──────────────────────────────────────────────────────────────

let rowSeq = 0;
function hist(opts: {
  studyId: string;
  observedAt: string;
  rewardMinor?: number;
  currency?: string;
  hourlyMinor?: number;
  placesAvailable?: number;
  name?: string;
  researcherId?: string;
  researcherName?: string;
  rowId?: number;
}): StudyHistoryRecord {
  const payload: Record<string, unknown> = {
    name: opts.name ?? 'Study A',
    places_available: opts.placesAvailable ?? 10,
    researcher: { id: opts.researcherId ?? 'r-1', name: opts.researcherName ?? 'Lab One' },
  };
  if (opts.rewardMinor !== undefined) payload.reward = { amount: opts.rewardMinor, currency: opts.currency ?? 'GBP' };
  if (opts.hourlyMinor !== undefined) payload.average_reward_per_hour = { amount: opts.hourlyMinor, currency: opts.currency ?? 'GBP' };
  return { row_id: opts.rowId ?? ++rowSeq, study_id: opts.studyId, observed_at: opts.observedAt, payload };
}

function evt(
  studyId: string,
  type: 'available' | 'unavailable',
  observedAt: string,
  name = 'Study A',
): StudyAvailabilityEventRecord {
  return { row_id: ++rowSeq, study_id: studyId, study_name: name, event_type: type, observed_at: observedAt };
}

const T = (h: number, m = 0, day = 1) =>
  `2025-03-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

// ──────────────────────────────────────────────────────────────
// Listing intervals + fill speed
// ──────────────────────────────────────────────────────────────

describe('listingIntervalsByStudy', () => {
  it('pairs available→unavailable and leaves an open interval when still listed', () => {
    const map = listingIntervalsByStudy([
      evt('s1', 'available', T(10)),
      evt('s1', 'unavailable', T(11)), // 3600s
      evt('s2', 'available', T(10)), // still listed
    ]);
    expect(map.get('s1')![0].duration_seconds).toBeCloseTo(3600, 5);
    expect(map.get('s2')![0].unavailable_at).toBeNull();
    expect(map.get('s2')![0].duration_seconds).toBeNull();
  });

  it('captures multiple cycles (reruns) for one study', () => {
    const map = listingIntervalsByStudy([
      evt('s1', 'available', T(10)),
      evt('s1', 'unavailable', T(11)),
      evt('s1', 'available', T(14)),
      evt('s1', 'unavailable', T(15)),
    ]);
    expect(map.get('s1')!.length).toBe(2);
  });

  it('tolerates orphan unavailable, duplicate available, and unparseable dates', () => {
    const map = listingIntervalsByStudy([
      evt('s1', 'unavailable', T(9)), // orphan
      evt('s1', 'available', T(10)),
      evt('s1', 'available', T(10, 30)), // duplicate available
      evt('s1', 'unavailable', T(11)), // pairs with first → 3600s
      evt('s2', 'available', 'not-a-date'),
      evt('s2', 'unavailable', T(12)),
    ]);
    expect(map.get('s1')!.length).toBe(1);
    expect(map.get('s1')![0].duration_seconds).toBeCloseTo(3600, 5);
    expect(map.get('s2')!.length).toBe(0); // available unparseable → nothing opens
  });
});

describe('computeFillSpeed', () => {
  it('summarizes first-close durations across studies', () => {
    const stats = computeFillSpeed([
      evt('s1', 'available', T(10)), evt('s1', 'unavailable', T(11)), // 3600
      evt('s2', 'available', T(10)), evt('s2', 'unavailable', T(10, 30)), // 1800
      evt('s3', 'available', T(10)), // still listed → not counted in sample
    ]);
    expect(stats.sample).toBe(2);
    expect(stats.studies_tracked).toBe(3);
    expect(stats.median_seconds).toBeCloseTo(2700, 5);
  });

  it('returns nulls with no closed listings', () => {
    const stats = computeFillSpeed([evt('s1', 'available', T(10))]);
    expect(stats.sample).toBe(0);
    expect(stats.median_seconds).toBeNull();
  });
});

describe('fastestFillingStudies', () => {
  const events = [
    evt('s1', 'available', T(10)), evt('s1', 'unavailable', T(10, 5)), // 300s
    evt('s2', 'available', T(10)), evt('s2', 'unavailable', T(11)), // 3600s
    evt('s3', 'available', T(10)), evt('s3', 'unavailable', T(10, 10)), // 600s
  ];
  const meta = buildStudyMeta([
    hist({ studyId: 's1', observedAt: T(10), name: 'Fast One', researcherId: 'r-1', researcherName: 'Alpha' }),
    hist({ studyId: 's2', observedAt: T(10), name: 'Slow', researcherId: 'r-1', researcherName: 'Alpha' }),
    hist({ studyId: 's3', observedAt: T(10), name: 'Mid', researcherId: 'r-2', researcherName: 'Beta' }),
  ]);

  it('ranks studies fastest-first with joined names', () => {
    const fastest = fastestFillingStudies(events, meta, 2);
    expect(fastest.map((f) => f.study_id)).toEqual(['s1', 's3']);
    expect(fastest[0].study_name).toBe('Fast One');
    expect(fastest[0].researcher_name).toBe('Alpha');
  });

  it('falls back to the event study name when meta is missing', () => {
    const fastest = fastestFillingStudies(events, undefined, 1);
    expect(fastest[0].study_name).toBe('Study A'); // from evt() default study_name
    expect(fastest[0].researcher_id).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────
// Price movement
// ──────────────────────────────────────────────────────────────

describe('computePriceChanges', () => {
  it('detects an upward reward bump', () => {
    const changes = computePriceChanges([
      hist({ studyId: 's1', observedAt: T(10), rewardMinor: 500 }),
      hist({ studyId: 's1', observedAt: T(11), rewardMinor: 500 }),
      hist({ studyId: 's1', observedAt: T(12), rewardMinor: 800 }),
    ]);
    expect(changes.length).toBe(1);
    const c = changes[0];
    expect(c.direction).toBe('up');
    expect(c.first_reward_minor).toBe(500);
    expect(c.last_reward_minor).toBe(800);
    expect(c.delta_minor).toBe(300);
    expect(c.pct).toBeCloseTo(0.6, 5);
    expect(c.changed_at).toBe(T(12));
    expect(c.currency).toBe('GBP');
  });

  it('detects a downward cut', () => {
    const changes = computePriceChanges([
      hist({ studyId: 's1', observedAt: T(10), rewardMinor: 900 }),
      hist({ studyId: 's1', observedAt: T(12), rewardMinor: 600 }),
    ]);
    expect(changes[0].direction).toBe('down');
    expect(changes[0].delta_minor).toBe(-300);
  });

  it('ignores studies whose reward never moved', () => {
    const changes = computePriceChanges([
      hist({ studyId: 's1', observedAt: T(10), rewardMinor: 500 }),
      hist({ studyId: 's1', observedAt: T(11), rewardMinor: 500 }),
    ]);
    expect(changes).toEqual([]);
  });

  it('ignores currency flips (does not count them as price moves)', () => {
    const changes = computePriceChanges([
      hist({ studyId: 's1', observedAt: T(10), rewardMinor: 500, currency: 'GBP' }),
      hist({ studyId: 's1', observedAt: T(11), rewardMinor: 700, currency: 'USD' }), // ignored
    ]);
    expect(changes).toEqual([]);
  });

  it('sorts most-recently-changed first', () => {
    const changes = computePriceChanges([
      hist({ studyId: 'old', observedAt: T(10, 0, 1), rewardMinor: 100 }),
      hist({ studyId: 'old', observedAt: T(11, 0, 1), rewardMinor: 200 }),
      hist({ studyId: 'new', observedAt: T(10, 0, 2), rewardMinor: 100 }),
      hist({ studyId: 'new', observedAt: T(11, 0, 2), rewardMinor: 200 }),
    ]);
    expect(changes.map((c) => c.study_id)).toEqual(['new', 'old']);
  });

  it('does not throw on malformed / missing reward payloads', () => {
    const rows: StudyHistoryRecord[] = [
      { row_id: 1, study_id: 's1', observed_at: T(10), payload: null as unknown as Record<string, unknown> },
      { row_id: 2, study_id: 's1', observed_at: T(11), payload: { reward: 'nope' } as unknown as Record<string, unknown> },
      { row_id: 3, study_id: 's1', observed_at: T(12), payload: { reward: { amount: 'NaN', currency: '' } } },
      { row_id: 4, study_id: '', observed_at: T(12), payload: {} },
    ];
    expect(() => computePriceChanges(rows)).not.toThrow();
    expect(computePriceChanges(rows)).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────
// Posting cadence
// ──────────────────────────────────────────────────────────────

describe('computePostingCadence', () => {
  it('buckets available events by local hour and day, and finds peaks', () => {
    // Three postings at hour 9 local (built from a local-time string), one at 14.
    const nine = (day: number) => new Date(2025, 2, day, 9, 0, 0).toISOString();
    const two = new Date(2025, 2, 3, 14, 0, 0).toISOString();
    const cadence = computePostingCadence([
      evt('a', 'available', nine(1)),
      evt('b', 'available', nine(2)),
      evt('c', 'available', nine(3)),
      evt('d', 'available', two),
      evt('a', 'unavailable', nine(1)), // ignored — not a posting
    ]);
    expect(cadence.total_postings).toBe(4);
    expect(cadence.by_hour[9].count).toBe(3);
    expect(cadence.by_hour[14].count).toBe(1);
    expect(cadence.peak_hour).toBe(9);
    expect(cadence.by_hour.length).toBe(24);
    expect(cadence.by_dow.length).toBe(7);
  });

  it('reports null peaks and zero total with no available events', () => {
    const cadence = computePostingCadence([evt('a', 'unavailable', T(10))]);
    expect(cadence.total_postings).toBe(0);
    expect(cadence.peak_hour).toBeNull();
    expect(cadence.peak_dow).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// Rerun detection
// ──────────────────────────────────────────────────────────────

describe('detectReruns', () => {
  it('flags a study reposted on a regular schedule', () => {
    // Available every 24h, three times → regular.
    const events = [
      evt('s1', 'available', T(10, 0, 1)), evt('s1', 'unavailable', T(11, 0, 1)),
      evt('s1', 'available', T(10, 0, 2)), evt('s1', 'unavailable', T(11, 0, 2)),
      evt('s1', 'available', T(10, 0, 3)), evt('s1', 'unavailable', T(11, 0, 3)),
    ];
    const meta = buildStudyMeta([hist({ studyId: 's1', observedAt: T(10, 0, 1), name: 'Weekly Panel', researcherName: 'Alpha' })]);
    const reruns = detectReruns(events, meta);
    expect(reruns.length).toBe(1);
    expect(reruns[0].appearances).toBe(3);
    expect(reruns[0].median_gap_seconds).toBeCloseTo(86400, 5);
    expect(reruns[0].regular).toBe(true);
    expect(reruns[0].study_name).toBe('Weekly Panel');
    expect(reruns[0].next_expected_at).toBe('2025-03-04T10:00:00.000Z');
  });

  it('does not flag a study listed only once', () => {
    const reruns = detectReruns([evt('s1', 'available', T(10)), evt('s1', 'unavailable', T(11))], undefined);
    expect(reruns).toEqual([]);
  });

  it('reports irregular reposts as not regular', () => {
    // A genuine rerun closes (unavailable) before reopening; gaps here are 24h then 7d.
    const events = [
      evt('s1', 'available', T(10, 0, 1)), evt('s1', 'unavailable', T(11, 0, 1)),
      evt('s1', 'available', T(10, 0, 2)), evt('s1', 'unavailable', T(11, 0, 2)), // +24h
      evt('s1', 'available', T(10, 0, 9)), evt('s1', 'unavailable', T(11, 0, 9)), // +7d — wildly different gap
    ];
    const reruns = detectReruns(events, undefined);
    expect(reruns[0].appearances).toBe(3);
    expect(reruns[0].regular).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// Retention: redundant history compaction
// ──────────────────────────────────────────────────────────────

describe('redundantHistoryRowIds', () => {
  it('drops strictly-interior duplicates but keeps endpoints and change-points', () => {
    // reward 500 x3 then 800 x2. Only the middle 500 (row 2) is strictly interior & unchanged.
    const rows = [
      hist({ rowId: 1, studyId: 's1', observedAt: T(10), rewardMinor: 500 }),
      hist({ rowId: 2, studyId: 's1', observedAt: T(11), rewardMinor: 500 }),
      hist({ rowId: 3, studyId: 's1', observedAt: T(12), rewardMinor: 500 }),
      hist({ rowId: 4, studyId: 's1', observedAt: T(13), rewardMinor: 800 }),
      hist({ rowId: 5, studyId: 's1', observedAt: T(14), rewardMinor: 800 }),
    ];
    expect(redundantHistoryRowIds(rows).sort()).toEqual([2]);
  });

  it('never drops when there are fewer than 3 snapshots', () => {
    const rows = [
      hist({ rowId: 1, studyId: 's1', observedAt: T(10), rewardMinor: 500 }),
      hist({ rowId: 2, studyId: 's1', observedAt: T(11), rewardMinor: 500 }),
    ];
    expect(redundantHistoryRowIds(rows)).toEqual([]);
  });

  it('ignores places_available drift (only reward/hourly are change-points), so active studies compact', () => {
    const rows = [
      hist({ rowId: 1, studyId: 's1', observedAt: T(10), rewardMinor: 500, placesAvailable: 10 }),
      hist({ rowId: 2, studyId: 's1', observedAt: T(11), rewardMinor: 500, placesAvailable: 7 }), // only places changed
      hist({ rowId: 3, studyId: 's1', observedAt: T(12), rewardMinor: 500, placesAvailable: 3 }), // only places changed
    ];
    // Reward/hourly are identical across all three, so the interior snapshot is redundant despite the
    // places drift — this is what lets an actively-filling study's per-refresh rows collapse.
    expect(redundantHistoryRowIds(rows)).toEqual([2]);
  });

  it('treats a reward change as a change-point (kept)', () => {
    const rows = [
      hist({ rowId: 1, studyId: 's1', observedAt: T(10), rewardMinor: 500 }),
      hist({ rowId: 2, studyId: 's1', observedAt: T(11), rewardMinor: 800 }), // reward changed
      hist({ rowId: 3, studyId: 's1', observedAt: T(12), rewardMinor: 800 }),
    ];
    expect(redundantHistoryRowIds(rows)).toEqual([]);
  });

  it('compacts a long unchanged run down to its two endpoints', () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      hist({ rowId: i + 1, studyId: 's1', observedAt: T(0, i), rewardMinor: 500 }),
    );
    const drop = redundantHistoryRowIds(rows);
    expect(drop.length).toBe(98); // keeps first + last only
    expect(drop).not.toContain(1);
    expect(drop).not.toContain(100);
  });
});

// ──────────────────────────────────────────────────────────────
// Bundle + adversarial
// ──────────────────────────────────────────────────────────────

describe('computeStudyHistoryInsights', () => {
  it('reports empty on empty input', () => {
    const insights = computeStudyHistoryInsights([], []);
    expect(insights.empty).toBe(true);
    expect(insights.price_changes).toEqual([]);
    expect(insights.fill_speed.sample).toBe(0);
    expect(insights.reruns).toEqual([]);
  });

  it('assembles all four analyses together (continuously-watched data)', () => {
    // Continuous observation: background study s0 seen every 10 min supplies the global timeline; s1
    // appears at 10:00 (we saw s0 at 09:50 without it → real drop) and is watched to its 10:30 close.
    const obs = [T(9, 50), T(10, 0), T(10, 10), T(10, 20), T(10, 30)];
    const history = [
      ...obs.map((t) => hist({ studyId: 's0', observedAt: t, rewardMinor: 300 })),
      hist({ studyId: 's1', observedAt: T(10, 0), rewardMinor: 500, name: 'Bumped', researcherName: 'Alpha' }),
      hist({ studyId: 's1', observedAt: T(10, 10), rewardMinor: 500, name: 'Bumped', researcherName: 'Alpha' }),
      hist({ studyId: 's1', observedAt: T(10, 20), rewardMinor: 900, name: 'Bumped', researcherName: 'Alpha' }),
      hist({ studyId: 's1', observedAt: T(10, 30), rewardMinor: 900, name: 'Bumped', researcherName: 'Alpha' }),
    ];
    const events = [evt('s1', 'available', T(10, 0)), evt('s1', 'unavailable', T(10, 30))];
    const insights = computeStudyHistoryInsights(history, events, { fastestLimit: 3 });
    expect(insights.empty).toBe(false);
    expect(insights.price_changes[0].direction).toBe('up');
    expect(insights.fill_speed.sample).toBe(1);
    expect(insights.fill_speed.skipped_unreliable).toBe(0);
    expect(insights.posting.total_postings).toBe(1);
    expect(insights.data_quality.sparse).toBe(false);
  });

  it('does not throw on a large mixed history', () => {
    const history: StudyHistoryRecord[] = [];
    const events: StudyAvailabilityEventRecord[] = [];
    for (let i = 0; i < 2000; i++) {
      const sid = `s${i % 50}`;
      history.push(hist({ studyId: sid, observedAt: T(i % 24, i % 60, (i % 28) + 1), rewardMinor: 400 + (i % 5) * 50 }));
      events.push(evt(sid, i % 2 === 0 ? 'available' : 'unavailable', T(i % 24, i % 60, (i % 28) + 1)));
    }
    const t0 = performance.now();
    const insights = computeStudyHistoryInsights(history, events);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(insights).toBeTruthy();
  });
});

describe('observation-aware reliability (sporadic usage)', () => {
  // A continuous-observation history: every study seen ~every 10 min while it's live.
  const denseHistory = (studyId: string, from: number, toIncl: number, day = 1) =>
    Array.from({ length: (toIncl - from) / 10 + 1 }, (_, i) =>
      hist({ studyId, observedAt: T(Math.floor((from + i * 10) / 60), (from + i * 10) % 60, day), rewardMinor: 400 }));

  it('keeps a listing we watched from appearance to close', () => {
    // Background study b provides an observation at 09:50 (before s appears at 10:00); s watched to close.
    const history = [
      ...denseHistory('b', 9 * 60 + 50, 10 * 60 + 40),
      ...denseHistory('s', 10 * 60, 10 * 60 + 30),
    ];
    const obs = buildObservations(history);
    const events = [evt('s', 'available', T(10, 0)), evt('s', 'unavailable', T(10, 30))];
    const stats = computeFillSpeed(events, obs);
    expect(stats.sample).toBe(1);
    expect(stats.skipped_unreliable).toBe(0);
    expect(stats.median_seconds).toBeCloseTo(1800, 5);
  });

  it('drops a listing whose close happened during an observation gap (the 161h bug)', () => {
    // s seen only on day 1; marked unavailable 7 days later when the extension next ran.
    const history = denseHistory('s', 10 * 60, 10 * 60 + 20, 1);
    const obs = buildObservations(history);
    const events = [evt('s', 'available', T(10, 0, 1)), evt('s', 'unavailable', T(10, 0, 8))];
    const stats = computeFillSpeed(events, obs);
    expect(stats.sample).toBe(0);
    expect(stats.skipped_unreliable).toBe(1);
    expect(stats.median_seconds).toBeNull();
  });

  it('takes the first RELIABLE close, not the first close (a later watched cycle still counts)', () => {
    // Cycle 1 closed during a gap (unreliable); cycle 2 was watched to close. The study should still
    // contribute cycle 2's duration, not be dropped as unreliable.
    const history = [
      ...denseHistory('s', 10 * 60, 10 * 60 + 10, 1), // watched briefly on day 1
      ...denseHistory('s', 10 * 60, 10 * 60 + 20, 8), // watched again on day 8 across cycle 2
    ];
    const obs = buildObservations(history);
    const events = [
      evt('s', 'available', T(10, 0, 1)), evt('s', 'unavailable', T(9, 0, 8)), // cycle 1 closed 7 days later (gap)
      evt('s', 'available', T(10, 0, 8)), evt('s', 'unavailable', T(10, 20, 8)), // cycle 2: watched, 20 min
    ];
    const stats = computeFillSpeed(events, obs);
    expect(stats.sample).toBe(1);
    expect(stats.skipped_unreliable).toBe(0);
    expect(stats.median_seconds).toBeCloseTo(1200, 5);
  });

  it('posting cadence excludes studies already listed when watching began', () => {
    // s appears at the very first observation → we never saw it "drop", so it must not count.
    const history = denseHistory('s', 10 * 60, 10 * 60 + 20, 1);
    const obs = buildObservations(history);
    const cadence = computePostingCadence([evt('s', 'available', T(10, 0, 1))], obs);
    expect(cadence.total_postings).toBe(0);
    expect(cadence.skipped_unreliable).toBe(1);
    expect(cadence.peak_hour).toBeNull();
  });

  it("reproduces the user's export: a batch already-present, all closed after a 6-day gap", () => {
    // 8 studies available at the first observation (17:51), all unavailable 6 days later — every
    // fill sample and every posting is unreliable → nothing usable, flagged sparse.
    const ids = Array.from({ length: 8 }, (_, i) => `study-${i}`);
    const history = ids.flatMap((id) => denseHistory(id, 17 * 60 + 51, 18 * 60 + 11, 22)); // watched ~20 min on day 22
    const events = [
      ...ids.map((id) => evt(id, 'available', T(17, 51, 22))),
      ...ids.map((id) => evt(id, 'unavailable', T(11, 39, 28))), // 6 days later
    ];
    const insights = computeStudyHistoryInsights(history, events);
    expect(insights.fill_speed.sample).toBe(0);
    expect(insights.fill_speed.skipped_unreliable).toBe(8);
    expect(insights.posting.total_postings).toBe(0);
    expect(insights.posting.skipped_unreliable).toBe(8);
    expect(insights.data_quality.sparse).toBe(true);
    expect(insights.empty).toBe(false); // there IS data — it's just untrustworthy
  });
});

describe('adversarial / hostile data', () => {
  it('handles a reward that starts at 0 without dividing by zero', () => {
    const changes = computePriceChanges([
      hist({ studyId: 's1', observedAt: T(10), rewardMinor: 0 }),
      hist({ studyId: 's1', observedAt: T(12), rewardMinor: 500 }),
    ]);
    expect(changes.length).toBe(1);
    expect(changes[0].direction).toBe('up');
    expect(changes[0].delta_minor).toBe(500);
    expect(Number.isFinite(changes[0].pct)).toBe(true);
    expect(changes[0].pct).toBe(0); // guarded: first reward is 0
  });

  it('redundantHistoryRowIds ignores rows without a row_id (undeletable)', () => {
    const rows: StudyHistoryRecord[] = [
      { study_id: 's1', observed_at: T(10), payload: { reward: { amount: 500, currency: 'GBP' } } }, // no row_id
      hist({ rowId: 2, studyId: 's1', observedAt: T(11), rewardMinor: 500 }),
      hist({ rowId: 3, studyId: 's1', observedAt: T(12), rewardMinor: 500 }),
      hist({ rowId: 4, studyId: 's1', observedAt: T(13), rewardMinor: 500 }),
    ];
    expect(redundantHistoryRowIds(rows)).toEqual([3]);
  });

  it('tolerates null / garbage history payloads in the bundle', () => {
    const history: StudyHistoryRecord[] = [
      { row_id: 1, study_id: 's1', observed_at: T(10), payload: null as unknown as Record<string, unknown> },
      { row_id: 2, study_id: 's1', observed_at: T(11), payload: { reward: 'nope' } as unknown as Record<string, unknown> },
    ];
    const events = [evt('s1', 'available', 'not-a-date'), evt('s1', 'unavailable', T(11))];
    expect(() => computeStudyHistoryInsights(history, events)).not.toThrow();
    expect(computeStudyHistoryInsights(history, events).empty).toBe(true);
  });

  it('stays fast on a large rerun/fill event history', () => {
    const events: StudyAvailabilityEventRecord[] = [];
    for (let s = 0; s < 200; s++) {
      for (let c = 0; c < 10; c++) {
        const day = (c % 27) + 1;
        events.push(evt(`s${s}`, 'available', T(9, 0, day)));
        events.push(evt(`s${s}`, 'unavailable', T(10, 0, day)));
      }
    }
    const t0 = performance.now();
    const reruns = detectReruns(events, undefined);
    const fill = computeFillSpeed(events);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(reruns.length).toBe(200);
    expect(fill.sample).toBe(200);
  });
});
