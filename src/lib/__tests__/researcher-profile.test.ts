import { describe, it, expect } from 'vitest';
import type { SubmissionRecord, StudyAvailabilityEventRecord, StudyHistoryRecord } from '../db';
import type { Study } from '../types';
import {
  computeReliability,
  computeResearcherMetrics,
  computeStudyContext,
  computeResearcherProfile,
  computeCompactProfiles,
  reliabilityBandLabel,
  reliabilityFor,
  RELIABILITY_MIN_TERMINAL,
} from '../researcher-profile';
import { buildObservations } from '../study-history';

interface SubOpts {
  id?: string;
  status?: string;
  researcherId?: string;
  researcherName?: string;
  country?: string;
  studyId?: string;
  rewardMinor?: number;
  currency?: string;
  durationSeconds?: number;
  startedAt?: string;
  observedAt?: string;
}

function makeSub(opts: SubOpts = {}): SubmissionRecord {
  const started = opts.startedAt ?? '2025-03-01T10:00:00.000Z';
  const durationSeconds = opts.durationSeconds ?? 600;
  const completed = new Date(new Date(started).getTime() + durationSeconds * 1000).toISOString();
  const status = opts.status ?? 'APPROVED';
  const isReturnedOrRejected = status === 'RETURNED' || status === 'REJECTED';
  const payload: Record<string, unknown> = {
    started_at: started,
    submission_reward: { amount: opts.rewardMinor ?? 500, currency: opts.currency ?? 'GBP' },
    study: {
      id: opts.studyId ?? 'study-1',
      researcher: {
        id: opts.researcherId ?? 'r-001',
        name: opts.researcherName ?? 'Oxford Lab',
        country: opts.country ?? 'United Kingdom',
      },
    },
  };
  if (isReturnedOrRejected) payload.returned_at = completed;
  else payload.completed_at = completed;

  return {
    submission_id: opts.id ?? `sub-${Math.round(Math.random() * 1e9)}`,
    study_id: opts.studyId ?? 'study-1',
    study_name: 'Test Study',
    participant_id: 'p-1',
    status,
    phase: 'submitted',
    payload,
    observed_at: opts.observedAt ?? completed,
    updated_at: completed,
  };
}

function makeSubs(status: string, n: number, extra: SubOpts = {}): SubmissionRecord[] {
  return Array.from({ length: n }, (_, i) => makeSub({ ...extra, id: `${status}-${i}`, status }));
}

describe('computeReliability', () => {
  it('reports unknown until enough terminal outcomes', () => {
    const r = computeReliability({ approved: 2, returned: 0, rejected: 0, screened_out: 0 });
    expect(r.hasEnoughData).toBe(false);
    expect(r.band).toBe('unknown');
    expect(reliabilityBandLabel(r.band)).toMatch(/not enough/i);
  });

  it('rates an all-approved researcher as excellent', () => {
    const r = computeReliability({ approved: 40, returned: 0, rejected: 0, screened_out: 0 });
    expect(r.hasEnoughData).toBe(true);
    expect(r.band).toBe('excellent');
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it('shrinks a single early rejection toward the prior (not catastrophic)', () => {
    // 2 approved, 1 rejected — raw fairness 0.67, but shrink keeps it respectable.
    const r = computeReliability({ approved: 2, returned: 0, rejected: 1, screened_out: 0 });
    expect(r.hasEnoughData).toBe(true);
    expect(r.score).toBeGreaterThan(70);
  });

  it('penalises frequent rejections', () => {
    const good = computeReliability({ approved: 90, returned: 2, rejected: 1, screened_out: 0 });
    const bad = computeReliability({ approved: 40, returned: 20, rejected: 20, screened_out: 0 });
    expect(bad.score).toBeLessThan(good.score);
    expect(bad.band === 'poor' || bad.band === 'fair').toBe(true);
  });

  it('penalises heavy screening-out', () => {
    const clean = computeReliability({ approved: 20, returned: 0, rejected: 0, screened_out: 0 });
    const screeny = computeReliability({ approved: 20, returned: 0, rejected: 0, screened_out: 20 });
    expect(screeny.score).toBeLessThan(clean.score);
  });

  it('needs exactly RELIABILITY_MIN_TERMINAL terminal outcomes', () => {
    const below = computeReliability({ approved: RELIABILITY_MIN_TERMINAL - 1, returned: 0, rejected: 0, screened_out: 0 });
    const at = computeReliability({ approved: RELIABILITY_MIN_TERMINAL, returned: 0, rejected: 0, screened_out: 0 });
    expect(below.hasEnoughData).toBe(false);
    expect(at.hasEnoughData).toBe(true);
  });

  it('is deliberately cautious (not harsh) on a tiny all-negative sample, then hardens with volume', () => {
    // Intentional sign-off: at the 3-outcome minimum, the 0.9 prior keeps a 3/3-rejected researcher
    // out of "Poor" (we avoid a harsh verdict on thin evidence). As negative volume grows the shrink
    // is overwhelmed and the band drops to Poor — the score must be monotonic in that direction.
    const tiny = computeReliability({ approved: 0, returned: 0, rejected: 3, screened_out: 0 });
    const more = computeReliability({ approved: 0, returned: 0, rejected: 9, screened_out: 0 });
    expect(tiny.band).toBe('fair');
    expect(more.band).toBe('poor');
    expect(more.score).toBeLessThan(tiny.score);
  });
});

describe('computeResearcherMetrics', () => {
  it('counts statuses and rates', () => {
    const subs = [
      ...makeSubs('APPROVED', 8),
      ...makeSubs('RETURNED', 1),
      ...makeSubs('REJECTED', 1),
      ...makeSubs('SCREENED OUT', 2),
      ...makeSubs('AWAITING REVIEW', 3),
    ];
    const m = computeResearcherMetrics(subs);
    expect(m.total).toBe(15);
    expect(m.counts.approved).toBe(8);
    expect(m.counts.awaiting_review).toBe(3);
    expect(m.terminal).toBe(12); // approved+returned+rejected+screened
    expect(m.decided).toBe(10); // excludes screened + awaiting
    expect(m.approval_rate).toBeCloseTo(8 / 10, 5);
    expect(m.screened_out_rate).toBeCloseTo(2 / 12, 5);
  });

  it('returns null rates when there is nothing to divide by', () => {
    const m = computeResearcherMetrics(makeSubs('AWAITING REVIEW', 4));
    expect(m.approval_rate).toBeNull();
    expect(m.screened_out_rate).toBeNull();
    expect(m.reliability.band).toBe('unknown');
  });

  it('computes hourly stats in the dominant currency only', () => {
    // £5 for 600s = £30/hr. 10 GBP + 2 USD; USD ignored for money stats.
    const subs = [
      ...makeSubs('APPROVED', 10, { rewardMinor: 500, durationSeconds: 600, currency: 'GBP' }),
      ...makeSubs('APPROVED', 2, { rewardMinor: 9999, durationSeconds: 600, currency: 'USD' }),
    ];
    const m = computeResearcherMetrics(subs);
    expect(m.currency).toBe('GBP');
    expect(m.hourly_series.length).toBe(10);
    expect(m.median_hourly).toBeCloseTo(30, 5);
  });

  it('computes duration-vs-estimate when estimates are supplied', () => {
    // actual 1200s = 20min; estimate 10min → ratio 2.0
    const subs = makeSubs('APPROVED', 5, { durationSeconds: 1200, studyId: 'study-x' });
    const m = computeResearcherMetrics(subs, (id) => (id === 'study-x' ? 10 : null));
    expect(m.duration_sample).toBe(5);
    expect(m.duration_vs_estimate).toBeCloseTo(2.0, 5);
  });

  it('leaves duration-vs-estimate null without estimates', () => {
    const m = computeResearcherMetrics(makeSubs('APPROVED', 5));
    expect(m.duration_vs_estimate).toBeNull();
    expect(m.duration_sample).toBe(0);
  });

  it('falls back to the estimate carried on the submission payload', () => {
    // No estimate resolver passed, but each payload embeds study.estimated_completion_time.
    // actual 1200s = 20min, embedded estimate 10min → ratio 2.0
    const subs = makeSubs('APPROVED', 4, { durationSeconds: 1200 }).map((s) => ({
      ...s,
      payload: {
        ...(s.payload as Record<string, unknown>),
        study: { ...((s.payload as Record<string, unknown>).study as object), estimated_completion_time: 10 },
      },
    }));
    const m = computeResearcherMetrics(subs);
    expect(m.duration_sample).toBe(4);
    expect(m.duration_vs_estimate).toBeCloseTo(2.0, 5);
  });

  it('ignores non-submitted rows', () => {
    const submitting = { ...makeSub(), phase: 'submitting' as const };
    const m = computeResearcherMetrics([submitting, ...makeSubs('APPROVED', 3)]);
    expect(m.total).toBe(3);
  });
});

describe('computeStudyContext', () => {
  const study = (id: string): Study => ({ id, researcher: { id: 'r-001', name: 'x', country: '' } } as unknown as Study);
  const evt = (studyId: string, type: 'available' | 'unavailable', observedAt: string): StudyAvailabilityEventRecord => ({
    row_id: undefined,
    study_id: studyId,
    study_name: 'S',
    event_type: type,
    observed_at: observedAt,
  });

  it('counts distinct studies and pairs available→unavailable for listing duration', () => {
    const studies = [study('s1'), study('s2')];
    const events = [
      evt('s1', 'available', '2025-03-01T10:00:00Z'),
      evt('s1', 'unavailable', '2025-03-01T11:00:00Z'), // 3600s
      evt('s2', 'available', '2025-03-01T10:00:00Z'),
      evt('s2', 'unavailable', '2025-03-01T10:30:00Z'), // 1800s
    ];
    const ctx = computeStudyContext(studies, events);
    expect(ctx.studies_posted).toBe(2);
    expect(ctx.listing_sample).toBe(2);
    expect(ctx.median_listing_seconds).toBeCloseTo((3600 + 1800) / 2, 5);
  });

  it('ignores events for studies not belonging to the researcher', () => {
    const ctx = computeStudyContext([study('s1')], [
      evt('other', 'available', '2025-03-01T10:00:00Z'),
      evt('other', 'unavailable', '2025-03-01T12:00:00Z'),
    ]);
    expect(ctx.studies_posted).toBe(1);
    expect(ctx.listing_sample).toBe(0);
    expect(ctx.median_listing_seconds).toBeNull();
  });

  it('skips studies still listed (no unavailable event)', () => {
    const ctx = computeStudyContext([study('s1')], [evt('s1', 'available', '2025-03-01T10:00:00Z')]);
    expect(ctx.median_listing_seconds).toBeNull();
  });

  it('excludes a listing whose close happened during an observation gap (sporadic usage)', () => {
    // Seen once (day 1), then marked unavailable 7 days later when Pulse next ran — the "duration" is
    // really the gap between sessions, so it must not feed the researcher's "typically listed" figure.
    const events = [
      evt('s1', 'available', '2025-03-01T10:00:00Z'),
      evt('s1', 'unavailable', '2025-03-08T10:00:00Z'),
    ];
    const history: StudyHistoryRecord[] = [{ study_id: 's1', observed_at: '2025-03-01T10:00:00Z', payload: {} }];
    const obs = buildObservations(history);
    const filtered = computeStudyContext([study('s1')], events, obs);
    expect(filtered.listing_sample).toBe(0);
    expect(filtered.median_listing_seconds).toBeNull();
    // Without an observation timeline (older callers), it still counts — backward compatible.
    expect(computeStudyContext([study('s1')], events).listing_sample).toBe(1);
  });
});

describe('computeResearcherProfile', () => {
  it('fills identity, seen range, and study context', () => {
    const subs = makeSubs('APPROVED', 5, {
      researcherId: 'r-042',
      researcherName: 'Cambridge Cognition',
      country: 'United Kingdom',
      studyId: 's1',
      observedAt: '2025-02-10T09:00:00Z',
    });
    subs.push(makeSub({ status: 'APPROVED', researcherId: 'r-042', studyId: 's1', observedAt: '2025-05-20T09:00:00Z' }));

    const studies = [{ id: 's1', estimated_completion_time: 10, researcher: { id: 'r-042' } } as unknown as Study];
    const events: StudyAvailabilityEventRecord[] = [
      { row_id: undefined, study_id: 's1', study_name: 'S', event_type: 'available', observed_at: '2025-02-10T08:00:00Z' },
      { row_id: undefined, study_id: 's1', study_name: 'S', event_type: 'unavailable', observed_at: '2025-02-10T08:20:00Z' },
    ];

    const profile = computeResearcherProfile({ id: 'r-042', submissions: subs, studies, availabilityEvents: events });
    expect(profile.name).toBe('Cambridge Cognition');
    expect(profile.country).toBe('United Kingdom');
    expect(profile.first_seen_at).toBe('2025-02-10T09:00:00Z');
    expect(profile.last_seen_at).toBe('2025-05-20T09:00:00Z');
    expect(profile.study?.studies_posted).toBe(1);
    expect(profile.study?.median_listing_seconds).toBeCloseTo(1200, 5);
    // estimate join active (10min estimate present)
    expect(profile.duration_vs_estimate).not.toBeNull();
  });

  it('prefers the researcher record for identity + seen range', () => {
    const profile = computeResearcherProfile({
      id: 'r-1',
      submissions: makeSubs('APPROVED', 3, { researcherId: 'r-1' }),
      researcher: {
        id: 'r-1',
        name: 'Record Name',
        country: 'Germany',
        first_seen_at: '2024-01-01T00:00:00Z',
        last_seen_at: '2025-01-01T00:00:00Z',
        study_count: 0,
        submission_count: 0,
      },
    });
    expect(profile.name).toBe('Record Name');
    expect(profile.country).toBe('Germany');
    expect(profile.first_seen_at).toBe('2024-01-01T00:00:00Z');
    expect(profile.study).toBeNull(); // no studies/events provided
  });

  it('lets the researcher record name win when the caller passed the id as the name', () => {
    // Simulates the StudyActionMenu path where a study has a researcher id but no name.
    const bare: SubmissionRecord = {
      submission_id: 's', study_id: 'x', study_name: '', participant_id: '', status: 'APPROVED',
      phase: 'submitted', payload: { study: { researcher: { id: 'r-7' } } }, observed_at: '2025-01-01T00:00:00Z', updated_at: '',
    };
    const profile = computeResearcherProfile({
      id: 'r-7',
      name: 'r-7', // caller passed the id as the name
      submissions: [bare],
      researcher: {
        id: 'r-7', name: 'Real Lab Name', country: 'GB',
        first_seen_at: '2024-01-01T00:00:00Z', last_seen_at: '2025-01-01T00:00:00Z',
        study_count: 0, submission_count: 0,
      },
    });
    expect(profile.name).toBe('Real Lab Name');
  });

  it('falls back to the id when no name is anywhere', () => {
    const bare: SubmissionRecord = {
      submission_id: 's', study_id: 'x', study_name: '', participant_id: '', status: 'APPROVED',
      phase: 'submitted', payload: { study: { researcher: { id: 'r-9' } } }, observed_at: '2025-01-01T00:00:00Z', updated_at: '',
    };
    const profile = computeResearcherProfile({ id: 'r-9', submissions: [bare] });
    expect(profile.name).toBe('r-9');
  });
});

describe('adversarial / hostile data', () => {
  it('handles a completely empty submission list', () => {
    const m = computeResearcherMetrics([]);
    expect(m.total).toBe(0);
    expect(m.approval_rate).toBeNull();
    expect(m.screened_out_rate).toBeNull();
    expect(m.currency).toBe('');
    expect(m.hourly).toBeNull();
    expect(m.median_hourly).toBeNull();
    expect(m.hourly_series).toEqual([]);
    expect(m.duration_vs_estimate).toBeNull();
    expect(m.reliability.band).toBe('unknown');
  });

  it('does not throw on malformed payloads (null / missing / garbage)', () => {
    const garbage: SubmissionRecord[] = [
      { submission_id: 'a', study_id: 's', study_name: '', participant_id: '', status: 'APPROVED', phase: 'submitted', payload: null as unknown as Record<string, unknown>, observed_at: '2025-01-01T00:00:00Z', updated_at: '' },
      { submission_id: 'b', study_id: 's', study_name: '', participant_id: '', status: 'APPROVED', phase: 'submitted', payload: { study: 'not-an-object', submission_reward: 42 } as unknown as Record<string, unknown>, observed_at: '2025-01-02T00:00:00Z', updated_at: '' },
      { submission_id: 'c', study_id: 's', study_name: '', participant_id: '', status: 'WEIRD STATUS', phase: 'submitted', payload: { submission_reward: { amount: 'NaN', currency: '' } }, observed_at: 'not-a-date', updated_at: '' },
      { submission_id: 'd', study_id: 's', study_name: '', participant_id: '', status: 'APPROVED', phase: 'submitted', payload: { submission_reward: { amount: -500, currency: 'GBP' } }, observed_at: '2025-01-03T00:00:00Z', updated_at: '' },
    ];
    expect(() => computeResearcherMetrics(garbage)).not.toThrow();
    const m = computeResearcherMetrics(garbage);
    expect(m.total).toBe(4);
    expect(m.counts.other).toBe(1); // the WEIRD STATUS row
    expect(m.hourly_series).toEqual([]); // no valid reward+duration
  });

  it('ignores durations where started_at is after completed_at', () => {
    const backwards = makeSub({ startedAt: '2025-03-01T10:00:00Z', durationSeconds: -600 });
    // makeSub computes completed = started + duration; negative → completed before started
    const m = computeResearcherMetrics([backwards], () => 10);
    expect(m.hourly_series).toEqual([]);
    expect(m.duration_vs_estimate).toBeNull();
  });

  it('picks the dominant currency and does not mix currencies in pay stats', () => {
    const subs = [
      ...makeSubs('APPROVED', 6, { rewardMinor: 600, durationSeconds: 600, currency: 'USD' }),
      ...makeSubs('APPROVED', 3, { rewardMinor: 600, durationSeconds: 600, currency: 'EUR' }),
    ];
    const m = computeResearcherMetrics(subs);
    expect(m.currency).toBe('USD');
    expect(m.hourly_series.length).toBe(6);
  });

  it('computeStudyContext tolerates out-of-order, duplicate, and orphan events', () => {
    const study = (id: string): Study => ({ id } as unknown as Study);
    const evt = (studyId: string, type: 'available' | 'unavailable', observedAt: string): StudyAvailabilityEventRecord => ({
      row_id: undefined, study_id: studyId, study_name: 'S', event_type: type, observed_at: observedAt,
    });
    const ctx = computeStudyContext(
      [study('s1'), study('s2'), study('s2')], // duplicate study id
      [
        evt('s1', 'unavailable', '2025-03-01T09:00:00Z'), // orphan unavailable first
        evt('s1', 'available', '2025-03-01T10:00:00Z'),
        evt('s1', 'available', '2025-03-01T10:30:00Z'), // duplicate available
        evt('s1', 'unavailable', '2025-03-01T11:00:00Z'), // pairs with first available → 3600s
        evt('s2', 'available', 'not-a-date'), // unparseable → no pairing
        evt('s2', 'unavailable', '2025-03-01T12:00:00Z'),
      ],
    );
    expect(ctx.studies_posted).toBe(2); // deduped
    expect(ctx.listing_sample).toBe(1);
    expect(ctx.median_listing_seconds).toBeCloseTo(3600, 5);
  });

  it('stays fast and correct on a large single-researcher history', () => {
    const big = makeSubs('APPROVED', 5000, { rewardMinor: 500, durationSeconds: 600 });
    const t0 = performance.now();
    const m = computeResearcherMetrics(big);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(m.total).toBe(5000);
    expect(m.reliability.band).toBe('excellent');
  });
});

describe('reliabilityFor', () => {
  it('returns null for a missing map or id', () => {
    expect(reliabilityFor(undefined, 'r-1')).toBeNull();
    expect(reliabilityFor(new Map(), '')).toBeNull();
    expect(reliabilityFor(new Map(), null)).toBeNull();
    expect(reliabilityFor(new Map(), undefined)).toBeNull();
  });

  it('returns the reliability of a known researcher, null for an unknown one', () => {
    const profiles = computeCompactProfiles(makeSubs('APPROVED', 5, { researcherId: 'r-x' }));
    const rel = reliabilityFor(profiles, 'r-x');
    expect(rel?.band).toBe('excellent');
    expect(reliabilityFor(profiles, 'r-unknown')).toBeNull();
  });
});

describe('computeCompactProfiles', () => {
  it('groups submissions by researcher id', () => {
    const subs = [
      ...makeSubs('APPROVED', 5, { researcherId: 'r-a', researcherName: 'Alpha' }),
      ...makeSubs('REJECTED', 2, { researcherId: 'r-b', researcherName: 'Beta' }),
    ];
    const map = computeCompactProfiles(subs);
    expect(map.size).toBe(2);
    expect(map.get('r-a')?.name).toBe('Alpha');
    expect(map.get('r-a')?.counts.approved).toBe(5);
    expect(map.get('r-b')?.counts.rejected).toBe(2);
    expect(map.get('r-a')?.study).toBeNull();
  });

  it('skips submissions without a researcher id', () => {
    const noResearcher: SubmissionRecord = {
      submission_id: 's', study_id: 'x', study_name: '', participant_id: '', status: 'APPROVED',
      phase: 'submitted', payload: {}, observed_at: '2025-01-01T00:00:00Z', updated_at: '',
    };
    const map = computeCompactProfiles([noResearcher, ...makeSubs('APPROVED', 1, { researcherId: 'r-z' })]);
    expect(map.size).toBe(1);
    expect(map.has('r-z')).toBe(true);
  });
});
