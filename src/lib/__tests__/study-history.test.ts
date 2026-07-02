import { describe, it, expect } from 'vitest';
import type { StudyHistoryRecord, StudyAvailabilityEventRecord } from '../db';
import {
  buildStudyMeta,
  listingIntervalsByStudy,
  firstListingDurationSeconds,
  computeFillSpeed,
  fastestFillingStudies,
  computePriceChanges,
  computePostingCadence,
  detectReruns,
  redundantHistoryRowIds,
  computeStudyHistoryInsights,
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

  it('firstListingDurationSeconds returns the first cycle duration, null when never closed', () => {
    expect(firstListingDurationSeconds([evt('s1', 'available', T(10)), evt('s1', 'unavailable', T(10, 30))])).toBeCloseTo(1800, 5);
    expect(firstListingDurationSeconds([evt('s1', 'available', T(10))])).toBeNull();
    expect(firstListingDurationSeconds([])).toBeNull();
  });

  it('firstListingDurationSeconds uses only the first cycle (a bad first close yields null)', () => {
    // First cycle opens and closes in the same instant (0s → null); it must NOT skip ahead to the
    // later valid cycle — matching the researcher-profile behaviour this shared helper replaced.
    const evs = [
      evt('s1', 'available', T(10)), evt('s1', 'unavailable', T(10)), // 0s → null duration
      evt('s1', 'available', T(11)), evt('s1', 'unavailable', T(12)), // 3600s (must be ignored)
    ];
    expect(firstListingDurationSeconds(evs)).toBeNull();
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

  it('assembles all four analyses together', () => {
    const history = [
      hist({ studyId: 's1', observedAt: T(10), rewardMinor: 500, name: 'Bumped', researcherName: 'Alpha' }),
      hist({ studyId: 's1', observedAt: T(12), rewardMinor: 900, name: 'Bumped', researcherName: 'Alpha' }),
    ];
    const events = [
      evt('s1', 'available', T(10)), evt('s1', 'unavailable', T(10, 30)),
      evt('s1', 'available', T(13)),
    ];
    const insights = computeStudyHistoryInsights(history, events, { fastestLimit: 3 });
    expect(insights.empty).toBe(false);
    expect(insights.price_changes[0].direction).toBe('up');
    expect(insights.fill_speed.sample).toBe(1);
    expect(insights.posting.total_postings).toBe(2);
    expect(insights.history_count).toBe(2);
    expect(insights.events_count).toBe(3);
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
