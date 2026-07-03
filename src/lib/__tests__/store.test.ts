import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import * as store from '../store';
import type { Study } from '../types';
import type { SubmissionSnapshot } from '../normalize';

function makeStudy(id: string, name: string, overrides: Partial<Study> = {}): Study {
  return {
    id, name,
    study_type: 'STANDARD',
    date_created: '2024-01-01T00:00:00Z',
    published_at: '2024-01-01T00:00:00Z',
    total_available_places: 100,
    places_taken: 0,
    places_available: 100,
    reward: { amount: 5, currency: 'GBP' },
    average_reward_per_hour: { amount: 10, currency: 'GBP' },
    max_submissions_per_participant: 1,
    researcher: { id: 'r1', name: 'Dr Test', country: 'UK' },
    description: 'Test study',
    estimated_completion_time: 600,
    device_compatibility: ['desktop'],
    peripheral_requirements: [],
    maximum_allowed_time: 3600,
    average_completion_time_in_seconds: 500,
    is_confidential: false,
    is_ongoing_study: false,
    submission_started_at: null,
    pii_enabled: false,
    is_custom_screening: false,
    study_labels: [],
    ai_inferred_study_labels: [],
    previous_submission_count: 0,
    ...overrides,
  };
}

function makeSnapshot(id: string, status: string, overrides: Partial<SubmissionSnapshot> = {}): SubmissionSnapshot {
  return {
    submission_id: id,
    study_id: 'study1',
    study_name: 'Test Study',
    participant_id: 'p1',
    status,
    phase: status === 'RESERVED' || status === 'ACTIVE' ? 'submitting' : 'submitted',
    payload: {},
    ...overrides,
  };
}

beforeEach(async () => {
  await db.studiesLatest.clear();
  await db.studiesHistory.clear();
  await db.studiesActiveSnapshot.clear();
  await db.studyAvailabilityEvents.clear();
  await db.serviceState.clear();
  await db.submissions.clear();
  await db.observationLog.clear();
});

// --- Service State ---

describe('setStudiesRefresh / getStudiesRefresh', () => {
  it('stores and retrieves refresh state', async () => {
    await store.setStudiesRefresh({
      observed_at: '2024-01-01T00:00:00Z',
      source: 'test',
      url: 'https://example.com',
      status_code: 200,
    });

    const state = await store.getStudiesRefresh();
    expect(state).not.toBeNull();
    expect(state!.last_studies_refresh_at).toBe('2024-01-01T00:00:00Z');
    expect(state!.last_studies_refresh_source).toBe('test');
    expect(state!.last_studies_refresh_url).toBe('https://example.com');
    expect(state!.last_studies_refresh_status).toBe(200);
  });

  it('returns null when no state exists', async () => {
    const state = await store.getStudiesRefresh();
    expect(state).toBeNull();
  });

  it('upserts on repeated calls', async () => {
    await store.setStudiesRefresh({ observed_at: 't1', source: 'first', url: 'u1', status_code: 200 });
    await store.setStudiesRefresh({ observed_at: 't2', source: 'second', url: 'u2', status_code: 201 });

    const state = await store.getStudiesRefresh();
    expect(state!.last_studies_refresh_source).toBe('second');
    expect(state!.last_studies_refresh_status).toBe(201);
  });
});

// --- Studies Storage ---

describe('storeNormalizedStudies', () => {
  it('stores studies in latest and history', async () => {
    const studies = [makeStudy('s1', 'Study 1'), makeStudy('s2', 'Study 2')];
    await store.storeNormalizedStudies(studies, '2024-01-01T00:00:00Z');

    const latest = await db.studiesLatest.toArray();
    expect(latest).toHaveLength(2);

    const history = await db.studiesHistory.toArray();
    expect(history).toHaveLength(2);
  });

  it('does nothing for empty array', async () => {
    await store.storeNormalizedStudies([], '2024-01-01T00:00:00Z');
    expect(await db.studiesLatest.count()).toBe(0);
  });

  it('updates latest on repeated store', async () => {
    await store.storeNormalizedStudies([makeStudy('s1', 'Old Name')], 't1');
    await store.storeNormalizedStudies([makeStudy('s1', 'New Name')], 't2');

    const latest = await db.studiesLatest.toArray();
    expect(latest).toHaveLength(1);
    expect(latest[0].name).toBe('New Name');

    // History should have both
    const history = await db.studiesHistory.toArray();
    expect(history).toHaveLength(2);
  });
});

// --- Availability Reconciliation ---

describe('reconcileAvailability', () => {
  it('detects newly available studies', async () => {
    const studies = [makeStudy('s1', 'Study 1'), makeStudy('s2', 'Study 2')];
    const summary = await store.reconcileAvailability(studies, 't1');

    expect(summary.newly_available).toHaveLength(2);
    expect(summary.became_unavailable).toHaveLength(0);
    expect(summary.newly_available.map((s) => s.study_id).sort()).toEqual(['s1', 's2']);
  });

  it('detects became unavailable studies', async () => {
    await store.reconcileAvailability([makeStudy('s1', 'Study 1'), makeStudy('s2', 'Study 2')], 't1');
    const summary = await store.reconcileAvailability([makeStudy('s1', 'Study 1')], 't2');

    expect(summary.newly_available).toHaveLength(0);
    expect(summary.became_unavailable).toHaveLength(1);
    expect(summary.became_unavailable[0].study_id).toBe('s2');
  });

  it('detects no changes when same studies', async () => {
    const studies = [makeStudy('s1', 'Study 1')];
    await store.reconcileAvailability(studies, 't1');
    const summary = await store.reconcileAvailability(studies, 't2');

    expect(summary.newly_available).toHaveLength(0);
    expect(summary.became_unavailable).toHaveLength(0);
  });

  it('handles empty to empty', async () => {
    const summary = await store.reconcileAvailability([], 't1');
    expect(summary.newly_available).toHaveLength(0);
    expect(summary.became_unavailable).toHaveLength(0);
  });

  it('handles all studies disappearing', async () => {
    await store.reconcileAvailability([makeStudy('s1', 'A'), makeStudy('s2', 'B')], 't1');
    const summary = await store.reconcileAvailability([], 't2');

    expect(summary.became_unavailable).toHaveLength(2);
    expect(summary.newly_available).toHaveLength(0);
  });

  it('preserves first_seen_at across reconciliations', async () => {
    await store.reconcileAvailability([makeStudy('s1', 'Study 1')], 't1');
    await store.reconcileAvailability([makeStudy('s1', 'Study 1')], 't2');

    const snapshot = await db.studiesActiveSnapshot.get('s1');
    expect(snapshot!.first_seen_at).toBe('t1');
    expect(snapshot!.last_seen_at).toBe('t2');
  });

  it('creates availability events', async () => {
    await store.reconcileAvailability([makeStudy('s1', 'Study 1')], 't1');
    await store.reconcileAvailability([], 't2');

    const events = await db.studyAvailabilityEvents.toArray();
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe('available');
    expect(events[1].event_type).toBe('unavailable');
  });

  it('sorts output by study_id', async () => {
    const studies = [makeStudy('z', 'Z'), makeStudy('a', 'A'), makeStudy('m', 'M')];
    const summary = await store.reconcileAvailability(studies, 't1');
    expect(summary.newly_available.map((s) => s.study_id)).toEqual(['a', 'm', 'z']);
  });

  it('skips studies with empty id', async () => {
    const studies = [makeStudy('', 'No ID'), makeStudy('s1', 'Valid')];
    const summary = await store.reconcileAvailability(studies, 't1');
    expect(summary.newly_available).toHaveLength(1);
    expect(summary.newly_available[0].study_id).toBe('s1');
  });
});

// --- Available Studies Query ---

describe('getCurrentAvailableStudies', () => {
  it('returns studies sorted by first_seen_at', async () => {
    await store.storeNormalizedStudies([makeStudy('s1', 'First')], 't1');
    await store.reconcileAvailability([makeStudy('s1', 'First')], 't1');

    await store.storeNormalizedStudies([makeStudy('s2', 'Second')], 't2');
    await store.reconcileAvailability([makeStudy('s1', 'First'), makeStudy('s2', 'Second')], 't2');

    const studies = await store.getCurrentAvailableStudies(100);
    expect(studies).toHaveLength(2);
    expect(studies[0].id).toBe('s1');
    expect(studies[1].id).toBe('s2');
    expect(studies[0].first_seen_at).toBe('t1');
    expect(studies[1].first_seen_at).toBe('t2');
  });

  it('respects limit', async () => {
    const studies = [makeStudy('s1', 'A'), makeStudy('s2', 'B'), makeStudy('s3', 'C')];
    await store.storeNormalizedStudies(studies, 't1');
    await store.reconcileAvailability(studies, 't1');

    const result = await store.getCurrentAvailableStudies(2);
    expect(result).toHaveLength(2);
  });

  it('returns empty array when no studies', async () => {
    const studies = await store.getCurrentAvailableStudies(100);
    expect(studies).toEqual([]);
  });

  it('excludes departed studies', async () => {
    const studies = [makeStudy('s1', 'A'), makeStudy('s2', 'B')];
    await store.storeNormalizedStudies(studies, 't1');
    await store.reconcileAvailability(studies, 't1');
    await store.reconcileAvailability([makeStudy('s1', 'A')], 't2');

    const result = await store.getCurrentAvailableStudies(100);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('s1');
  });
});

// --- Availability Events Query ---

describe('getRecentAvailabilityEvents', () => {
  it('returns events in reverse order', async () => {
    await store.reconcileAvailability([makeStudy('s1', 'A')], 't1');
    await store.reconcileAvailability([makeStudy('s1', 'A'), makeStudy('s2', 'B')], 't2');

    const events = await store.getRecentAvailabilityEvents(10);
    expect(events).toHaveLength(2);
    // Most recent first
    expect(events[0].study_id).toBe('s2');
    expect(events[0].event_type).toBe('available');
  });

  it('enriches events with study data', async () => {
    await store.storeNormalizedStudies([makeStudy('s1', 'A', { reward: { amount: 5, currency: 'GBP' } })], 't1');
    await store.reconcileAvailability([makeStudy('s1', 'A')], 't1');

    const events = await store.getRecentAvailabilityEvents(10);
    expect(events[0].reward.amount).toBe(5);
  });

  it('handles missing study data gracefully', async () => {
    // Create event without storing the study in studiesLatest
    await db.studyAvailabilityEvents.add({
      study_id: 'orphan', study_name: 'Orphan', event_type: 'available', observed_at: 't1',
    });

    const events = await store.getRecentAvailabilityEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].reward).toEqual({ amount: 0, currency: '' });
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.reconcileAvailability([makeStudy(`s${i}`, `Study ${i}`)], `t${i}`);
      await store.reconcileAvailability([], `t${i}b`);
    }

    const events = await store.getRecentAvailabilityEvents(3);
    expect(events).toHaveLength(3);
  });
});

// --- Submissions ---

describe('upsertSubmission', () => {
  it('inserts a new submission', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'RESERVED'), 't1');

    const records = await db.submissions.toArray();
    expect(records).toHaveLength(1);
    expect(records[0].submission_id).toBe('sub1');
    expect(records[0].phase).toBe('submitting');
  });

  it('updates status and phase on conflict', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'RESERVED'), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED'), 't2');

    const records = await db.submissions.toArray();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('APPROVED');
    expect(records[0].phase).toBe('submitted');
  });

  it('preserves better study_name', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'RESERVED', { study_name: 'Real Name' }), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'ACTIVE', { study_name: 'Unknown Study' }), 't2');

    const records = await db.submissions.toArray();
    expect(records[0].study_name).toBe('Real Name');
  });

  it('preserves better study_id', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'RESERVED', { study_id: 'real_id' }), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'ACTIVE', { study_id: 'unknown' }), 't2');

    const records = await db.submissions.toArray();
    expect(records[0].study_id).toBe('real_id');
  });

  it('preserves payload with completed_at when new lacks it', async () => {
    const oldPayload = { completed_at: '2024-01-01', data: 'old' };
    const newPayload = { data: 'new' };

    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED', { payload: oldPayload }), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED', { payload: newPayload }), 't2');

    const records = await db.submissions.toArray();
    expect((records[0].payload as any).completed_at).toBe('2024-01-01');
  });

  it('preserves payload with returned_at when new lacks it', async () => {
    const oldPayload = { returned_at: '2024-01-01' };
    const newPayload = {};

    await store.upsertSubmission(makeSnapshot('sub1', 'RETURNED', { payload: oldPayload }), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'RETURNED', { payload: newPayload }), 't2');

    const records = await db.submissions.toArray();
    expect((records[0].payload as any).returned_at).toBe('2024-01-01');
  });

  it('replaces payload when new also has timestamps', async () => {
    const oldPayload = { completed_at: '2024-01-01' };
    const newPayload = { completed_at: '2024-01-02', extra: true };

    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED', { payload: oldPayload }), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED', { payload: newPayload }), 't2');

    const records = await db.submissions.toArray();
    expect((records[0].payload as any).completed_at).toBe('2024-01-02');
  });

  it('preserves observed_at for same-phase submitted entries', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED'), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED'), 't2');

    const records = await db.submissions.toArray();
    expect(records[0].observed_at).toBe('t1');
  });

  it('updates observed_at on phase change', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'RESERVED'), 't1');
    await store.upsertSubmission(makeSnapshot('sub1', 'APPROVED'), 't2');

    const records = await db.submissions.toArray();
    expect(records[0].observed_at).toBe('t2');
  });

  it('throws on empty status', async () => {
    await expect(store.upsertSubmission(makeSnapshot('sub1', ''), 't1')).rejects.toThrow('missing status');
  });

  it('replaces a codeless CSV stub by signature (name + started_at + reward)', async () => {
    // Prolific RETURNED rows in the CSV export have no Completion Code.
    await db.submissions.add({
      submission_id: 'csv:image-matching-study:2026-01-01T10:00:00.000Z',
      study_id: 'csv:image-matching-study',
      study_name: 'Image Matching Study',
      participant_id: 'csv-import',
      status: 'RETURNED',
      phase: 'submitted',
      payload: {
        started_at: '2026-01-01T10:00:00.000Z',
        submission_reward: { amount: 267, currency: 'GBP' },
      },
      observed_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    });
    await store.upsertSubmission(makeSnapshot('live-id-x', 'RETURNED', {
      study_id: 'real-uuid-2',
      study_name: 'Image Matching Study',
      // Live payload uses microsecond precision; signature rounds to seconds.
      payload: {
        started_at: '2026-01-01T10:00:00.123000Z',
        submission_reward: { amount: 267, currency: 'GBP' },
      },
    }), '2026-01-02T00:00:00Z');

    expect(await db.submissions.get('csv:image-matching-study:2026-01-01T10:00:00.000Z')).toBeUndefined();
    expect(await db.submissions.get('live-id-x')).toBeDefined();
  });

  it('does not delete unrelated CSV rows when signatures differ', async () => {
    await db.submissions.add({
      submission_id: 'csv:other-study:2026-01-01T10:00:00.000Z',
      study_id: 'csv:other-study',
      study_name: 'Other Study',
      participant_id: 'csv-import',
      status: 'APPROVED',
      phase: 'submitted',
      payload: {
        started_at: '2026-01-01T10:00:00.000Z',
        submission_reward: { amount: 500, currency: 'GBP' },
      },
      observed_at: '2026-01-01T10:00:00.000Z',
      updated_at: '2026-01-01T10:00:00.000Z',
    });
    await store.upsertSubmission(makeSnapshot('live-id-y', 'APPROVED', {
      study_name: 'Different Study',
      payload: {
        started_at: '2026-01-01T10:00:00.000Z',
        submission_reward: { amount: 500, currency: 'GBP' },
      },
    }), '2026-01-02T00:00:00Z');
    expect(await db.submissions.get('csv:other-study:2026-01-01T10:00:00.000Z')).toBeDefined();
  });

  it('replaces a CSV-imported stub when the matching live response arrives', async () => {
    await db.submissions.add({
      submission_id: 'csv:CABC1234',
      study_id: 'csv:image-matching-study',
      study_name: 'Image Matching Study',
      participant_id: 'csv-import',
      status: 'APPROVED',
      phase: 'submitted',
      payload: { completion_code: 'CABC1234', started_at: '2026-01-01T10:00:00Z' },
      observed_at: '2026-01-01T10:05:00Z',
      updated_at: '2026-01-01T10:05:00Z',
    });
    await store.upsertSubmission(makeSnapshot('live-id-1', 'APPROVED', {
      study_id: 'real-uuid-1',
      study_name: 'Image Matching Study',
      payload: { study_code: 'CABC1234', started_at: '2026-01-01T10:00:00Z', completed_at: '2026-01-01T10:05:00Z' },
    }), '2026-01-02T00:00:00Z');

    expect(await db.submissions.get('csv:CABC1234')).toBeUndefined();
    const live = await db.submissions.get('live-id-1');
    expect(live?.study_id).toBe('real-uuid-1');
  });
});

describe('getCurrentSubmissions', () => {
  it('returns all submissions ordered by observed_at DESC', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'RESERVED'), 't1');
    await store.upsertSubmission(makeSnapshot('sub2', 'APPROVED'), 't2');
    await store.upsertSubmission(makeSnapshot('sub3', 'ACTIVE'), 't3');

    const results = await store.getCurrentSubmissions(100, 'all');
    expect(results).toHaveLength(3);
    expect(results[0].submission_id).toBe('sub3');
    expect(results[2].submission_id).toBe('sub1');
  });

  it('filters by phase', async () => {
    await store.upsertSubmission(makeSnapshot('sub1', 'RESERVED'), 't1');
    await store.upsertSubmission(makeSnapshot('sub2', 'APPROVED'), 't2');

    const submitting = await store.getCurrentSubmissions(100, 'submitting');
    expect(submitting).toHaveLength(1);
    expect(submitting[0].submission_id).toBe('sub1');

    const submitted = await store.getCurrentSubmissions(100, 'submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].submission_id).toBe('sub2');
  });

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.upsertSubmission(makeSnapshot(`sub${i}`, 'RESERVED'), `t${i}`);
    }

    const results = await store.getCurrentSubmissions(3, 'all');
    expect(results).toHaveLength(3);
  });

  it('secondary sort by submission_id DESC on tie', async () => {
    await store.upsertSubmission(makeSnapshot('a', 'RESERVED'), 't1');
    await store.upsertSubmission(makeSnapshot('b', 'ACTIVE'), 't1');
    await store.upsertSubmission(makeSnapshot('c', 'RESERVED'), 't1');

    const results = await store.getCurrentSubmissions(100, 'all');
    expect(results.map((r) => r.submission_id)).toEqual(['c', 'b', 'a']);
  });

  it('returns empty array when no submissions', async () => {
    const results = await store.getCurrentSubmissions(100, 'all');
    expect(results).toEqual([]);
  });
});

describe('importSubmissions', () => {
  function makeRecord(id: string) {
    return {
      submission_id: id,
      study_id: `study-${id}`,
      study_name: `Study ${id}`,
      participant_id: 'csv-import',
      status: 'APPROVED',
      phase: 'submitted' as const,
      payload: { started_at: '2026-01-01T10:00:00Z', completed_at: '2026-01-01T10:05:00Z' },
      observed_at: '2026-01-01T10:05:00Z',
      updated_at: '2026-01-01T10:05:00Z',
    };
  }

  it('adds all records when DB is empty', async () => {
    const summary = await store.importSubmissions([makeRecord('a'), makeRecord('b')]);
    expect(summary).toEqual({ added: 2, skipped_existing: 0, total: 2 });
    expect(await db.submissions.count()).toBe(2);
  });

  it('skips records whose submission_id already exists', async () => {
    await store.importSubmissions([makeRecord('a'), makeRecord('b')]);
    const summary = await store.importSubmissions([makeRecord('a'), makeRecord('c')]);
    expect(summary).toEqual({ added: 1, skipped_existing: 1, total: 2 });
    expect(await db.submissions.count()).toBe(3);
  });

  it('is a no-op on empty input', async () => {
    expect(await store.importSubmissions([])).toEqual({ added: 0, skipped_existing: 0, total: 0 });
  });

  it('does not overwrite an existing record when the same id re-appears', async () => {
    const original = { ...makeRecord('a'), study_name: 'Original' };
    await db.submissions.add(original);
    const changed = { ...makeRecord('a'), study_name: 'Changed in CSV' };
    await store.importSubmissions([changed]);
    const kept = await db.submissions.get('a');
    expect(kept?.study_name).toBe('Original');
  });

  it('skips CSV rows whose completion_code matches an existing submission', async () => {
    await db.submissions.add({
      ...makeRecord('live-1'),
      study_id: 'real-uuid-1',
      study_name: 'Widgets',
      payload: { started_at: '2026-01-01T10:00:00Z', completion_code: 'CABC1234' },
    });
    const csvDupe = {
      ...makeRecord('csv:CABC1234'),
      study_id: 'csv:widgets',
      study_name: 'Widgets',
      payload: { started_at: '2026-01-01T10:00:00Z', completion_code: 'CABC1234' },
    };
    const csvNew = {
      ...makeRecord('csv:CXYZ9999'),
      study_id: 'csv:other',
      study_name: 'Other',
      payload: { started_at: '2026-01-02T10:00:00Z', completion_code: 'CXYZ9999' },
    };
    const summary = await store.importSubmissions([csvDupe, csvNew]);
    expect(summary).toEqual({ added: 1, skipped_existing: 1, total: 2 });
    expect(await db.submissions.count()).toBe(2);
  });

  it('skips CSV rows whose completion_code matches a live submission\'s study_code', async () => {
    await db.submissions.add({
      ...makeRecord('live-1'),
      study_id: 'real-uuid-1',
      study_name: 'Widgets',
      payload: { started_at: '2026-01-01T10:00:00Z', study_code: 'CLIVECODE' },
    });
    const csvRow = {
      ...makeRecord('csv:CLIVECODE'),
      study_id: 'csv:widgets',
      study_name: 'Widgets',
      payload: { started_at: '2026-01-01T10:00:00Z', completion_code: 'CLIVECODE' },
    };
    const summary = await store.importSubmissions([csvRow]);
    expect(summary).toEqual({ added: 0, skipped_existing: 1, total: 1 });
    expect(await db.submissions.count()).toBe(1);
  });

  it('signature-dedupes a codeless CSV row against an existing live submission', async () => {
    await db.submissions.add({
      submission_id: 'live-1',
      study_id: 'real-uuid',
      study_name: 'Some Study',
      participant_id: 'p',
      status: 'RETURNED',
      phase: 'submitted',
      // Live payload — no study_code, microsecond timestamp.
      payload: {
        started_at: '2026-02-25T08:42:19.447000Z',
        submission_reward: { amount: 234, currency: 'USD' },
      },
      observed_at: '2026-02-25T08:42:19.447Z',
      updated_at: '2026-02-25T08:42:19.447Z',
    });
    const csvRow = {
      submission_id: 'csv:some-study:2026-02-25T08:42:19.447Z',
      study_id: 'csv:some-study',
      study_name: 'Some Study',
      participant_id: 'csv-import',
      status: 'RETURNED',
      phase: 'submitted' as const,
      payload: {
        started_at: '2026-02-25T08:42:19.447Z',
        submission_reward: { amount: 234, currency: 'USD' },
      },
      observed_at: '2026-02-25T08:42:19.447Z',
      updated_at: '2026-04-17T01:00:00.000Z',
    };
    const summary = await store.importSubmissions([csvRow]);
    expect(summary).toEqual({ added: 0, skipped_existing: 1, total: 1 });
  });

  it('dedupes duplicate completion_codes within a single import batch', async () => {
    const a = {
      ...makeRecord('csv:DUPE1'),
      payload: { started_at: '2026-01-01T10:00:00Z', completion_code: 'DUPE1' },
    };
    const b = {
      ...makeRecord('csv:DUPE1-other'),
      payload: { started_at: '2026-01-02T10:00:00Z', completion_code: 'DUPE1' },
    };
    const summary = await store.importSubmissions([a, b]);
    expect(summary).toEqual({ added: 1, skipped_existing: 1, total: 2 });
  });
});

describe('getStudyTypeMap', () => {
  it('maps study_id to a display label from observed studies, omitting unlabelled', async () => {
    await store.storeNormalizedStudies([
      makeStudy('study-1', 'Survey A', { ai_inferred_study_labels: ['survey'] }),
      makeStudy('study-2', 'Interview B', { study_labels: ['interview'], ai_inferred_study_labels: ['survey'] }),
      makeStudy('study-3', 'Untyped C'), // no labels → omitted
    ], '2026-04-01T00:00:00Z');

    const map = await store.getStudyTypeMap();
    expect(map.get('study-1')).toBe('Survey');
    // explicit study_labels win over ai_inferred
    expect(map.get('study-2')).toBe('Interview');
    expect(map.has('study-3')).toBe(false);
  });

  it('returns an empty map when no studies observed', async () => {
    const map = await store.getStudyTypeMap();
    expect(map.size).toBe(0);
  });
});

describe('getStudyTypeMap — malformed payloads', () => {
  it('survives non-string labels, null, string-instead-of-array, missing fields', async () => {
    await db.studiesLatest.bulkPut([
      // study_labels[0] is a number — formatStudyLabel(...).trim() would throw on it
      { study_id: 's-num', name: 'n', payload: { study_labels: [123], ai_inferred_study_labels: ['survey'] }, last_seen_at: 't' },
      { study_id: 's-null', name: 'n', payload: { study_labels: null, ai_inferred_study_labels: null }, last_seen_at: 't' },
      { study_id: 's-str', name: 'n', payload: { study_labels: 'survey' }, last_seen_at: 't' },
      { study_id: 's-empty', name: 'n', payload: {}, last_seen_at: 't' },
      { study_id: 's-ok', name: 'n', payload: { study_labels: ['interview'] }, last_seen_at: 't' },
    ]);
    const map = await store.getStudyTypeMap();
    expect(map.get('s-ok')).toBe('Interview');
    // non-string first element is ignored, falling through to ai_inferred 'survey'
    expect(map.get('s-num')).toBe('Survey');
    expect(map.has('s-null')).toBe(false);
    expect(map.has('s-str')).toBe(false);
    expect(map.has('s-empty')).toBe(false);
  });
});

describe('getResearcherStudyData', () => {
  it('returns empty result for a blank id', async () => {
    const data = await store.getResearcherStudyData('   ');
    expect(data.researcher).toBeNull();
    expect(data.studies).toEqual([]);
    expect(data.availabilityEvents).toEqual([]);
    expect(data.observations.all).toEqual([]);
  });

  it('joins studies + availability events for a researcher, skipping other researchers', async () => {
    await db.researchers.clear();
    await db.researchers.put({
      id: 'r-target', name: 'Target Lab', country: 'GB',
      first_seen_at: '2025-01-01T00:00:00Z', last_seen_at: '2025-02-01T00:00:00Z',
      study_count: 0, submission_count: 0,
    });
    await db.studiesLatest.bulkPut([
      { study_id: 'sa', name: 'A', payload: { id: 'sa', researcher: { id: 'r-target' } }, last_seen_at: 't' },
      { study_id: 'sb', name: 'B', payload: { id: 'sb', researcher: { id: 'r-target' } }, last_seen_at: 't' },
      { study_id: 'sc', name: 'C', payload: { id: 'sc', researcher: { id: 'r-other' } }, last_seen_at: 't' },
    ]);
    await db.studyAvailabilityEvents.bulkAdd([
      { study_id: 'sa', study_name: 'A', event_type: 'available', observed_at: '2025-03-01T10:00:00Z' },
      { study_id: 'sa', study_name: 'A', event_type: 'unavailable', observed_at: '2025-03-01T11:00:00Z' },
      { study_id: 'sc', study_name: 'C', event_type: 'available', observed_at: '2025-03-01T10:00:00Z' }, // other researcher
    ]);

    const data = await store.getResearcherStudyData('r-target');
    expect(data.researcher?.name).toBe('Target Lab');
    expect(data.studies.map((s) => s.id).sort()).toEqual(['sa', 'sb']);
    expect(data.availabilityEvents.every((e) => e.study_id === 'sa')).toBe(true);
    expect(data.availabilityEvents.length).toBe(2);
  });

  it('returns a null researcher record but still finds studies when the record is missing', async () => {
    await db.researchers.clear();
    await db.studiesLatest.put({ study_id: 'sx', name: 'X', payload: { id: 'sx', researcher: { id: 'r-noRec' } }, last_seen_at: 't' });
    const data = await store.getResearcherStudyData('r-noRec');
    expect(data.researcher).toBeNull();
    expect(data.studies.map((s) => s.id)).toEqual(['sx']);
    expect(data.availabilityEvents).toEqual([]);
  });
});

// --- Study-history insights + retention (issue #19) ---

describe('getStudyInsights', () => {
  it('computes insights from stored history + events', async () => {
    // Continuously watched: a background study b gives an observation before s1 appears, and s1 is
    // seen every ~10 min from its 10:00 appearance to its 10:30 close (so the listing is trustworthy).
    const bumpy = (amount: number, at: string) => ({
      study_id: 's1', observed_at: at,
      payload: { name: 'Bumpy', reward: { amount, currency: 'GBP' }, researcher: { id: 'r1', name: 'Lab' } },
    });
    await db.studiesHistory.bulkAdd([
      { study_id: 'b', observed_at: '2026-03-01T09:50:00Z', payload: { reward: { amount: 300, currency: 'GBP' } } },
      bumpy(500, '2026-03-01T10:00:00Z'),
      bumpy(500, '2026-03-01T10:10:00Z'),
      bumpy(900, '2026-03-01T10:20:00Z'),
      bumpy(900, '2026-03-01T10:30:00Z'),
    ]);
    await db.studyAvailabilityEvents.bulkAdd([
      { study_id: 's1', study_name: 'Bumpy', event_type: 'available', observed_at: '2026-03-01T10:00:00Z' },
      { study_id: 's1', study_name: 'Bumpy', event_type: 'unavailable', observed_at: '2026-03-01T10:30:00Z' },
    ]);
    const insights = await store.getStudyInsights();
    expect(insights.empty).toBe(false);
    expect(insights.price_changes[0].direction).toBe('up');
    expect(insights.price_changes[0].study_name).toBe('Bumpy');
    expect(insights.fill_speed.sample).toBe(1);
    expect(insights.posting.total_postings).toBe(1);
  });

  it('reports empty when nothing is stored', async () => {
    const insights = await store.getStudyInsights();
    expect(insights.empty).toBe(true);
  });

  it('recordObservation heartbeat lets getStudyInsights count a drop history alone would reject', async () => {
    // Only study s is in history (as after an empty-feed stretch), so it has no prior observation and
    // its 11:00 appearance would be dropped — until a heartbeat proves we were watching at 10:50.
    await db.studiesHistory.bulkAdd([
      { study_id: 's', observed_at: '2026-03-01T11:00:00Z', payload: { reward: { amount: 500, currency: 'GBP' } } },
      { study_id: 's', observed_at: '2026-03-01T11:05:00Z', payload: { reward: { amount: 500, currency: 'GBP' } } },
    ]);
    await db.studyAvailabilityEvents.add({ study_id: 's', study_name: 'S', event_type: 'available', observed_at: '2026-03-01T11:00:00Z' });

    expect((await store.getStudyInsights()).posting.total_postings).toBe(0);
    await store.recordObservation('2026-03-01T10:50:00Z');
    expect((await store.getStudyInsights()).posting.total_postings).toBe(1);
  });

  it('recordObservation downsamples heartbeats to at most one per OBSERVATION_MIN_SPACING_MS (5 min)', async () => {
    await store.recordObservation('2026-03-01T10:00:00Z'); // first → recorded
    await store.recordObservation('2026-03-01T10:02:00Z'); // +2 min from last recorded → skipped
    await store.recordObservation('2026-03-01T10:04:00Z'); // +4 min from last recorded (10:00) → skipped
    await store.recordObservation('2026-03-01T10:06:00Z'); // +6 min from 10:00 → recorded
    await store.recordObservation('2026-03-01T10:06:30Z'); // +30s from 10:06 → skipped
    const rows = await db.observationLog.toArray();
    expect(rows.map((r) => r.at)).toEqual(['2026-03-01T10:00:00Z', '2026-03-01T10:06:00Z']);
  });

  it('tolerates malformed history / event rows in the DB', async () => {
    await db.studiesHistory.bulkAdd([
      { study_id: 's1', observed_at: '2026-03-01T10:00:00Z', payload: null as unknown as Record<string, unknown> },
      { study_id: 's1', observed_at: '2026-03-01T11:00:00Z', payload: { reward: 'nope' } as unknown as Record<string, unknown> },
      { study_id: '', observed_at: 'not-a-date', payload: {} },
    ]);
    await db.studyAvailabilityEvents.bulkAdd([
      { study_id: 's1', study_name: 'X', event_type: 'available', observed_at: 'not-a-date' },
      { study_id: 's1', study_name: 'X', event_type: 'unavailable', observed_at: '2026-03-01T11:00:00Z' },
    ]);
    const insights = await store.getStudyInsights();
    expect(insights).toBeTruthy();
    expect(insights.empty).toBe(true);
  });
});

describe('pruneStudyHistory', () => {
  const at = (h: number) => `2026-03-01T${String(h).padStart(2, '0')}:00:00Z`;

  it('drops strictly-redundant interior snapshots, keeping endpoints + change-points', async () => {
    await db.studiesHistory.bulkAdd([
      { study_id: 's1', observed_at: at(1), payload: { reward: { amount: 500, currency: 'GBP' }, places_available: 5 } }, // kept (first)
      { study_id: 's1', observed_at: at(2), payload: { reward: { amount: 500, currency: 'GBP' }, places_available: 5 } }, // redundant (interior)
      { study_id: 's1', observed_at: at(3), payload: { reward: { amount: 500, currency: 'GBP' }, places_available: 5 } }, // redundant (interior)
      { study_id: 's1', observed_at: at(4), payload: { reward: { amount: 500, currency: 'GBP' }, places_available: 5 } }, // kept (last of run before change)
      { study_id: 's1', observed_at: at(5), payload: { reward: { amount: 800, currency: 'GBP' }, places_available: 5 } }, // change-point
      { study_id: 's1', observed_at: at(6), payload: { reward: { amount: 800, currency: 'GBP' }, places_available: 5 } }, // kept (last)
    ]);
    const deleted = await store.pruneStudyHistory(new Date('2026-03-02T00:00:00Z'));
    expect(deleted).toBe(2);
    expect(await db.studiesHistory.where('study_id').equals('s1').count()).toBe(4);
  });

  it('drops snapshots older than the retention window (age backstop)', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const old = new Date(now.getTime() - 200 * 86_400_000).toISOString();
    const recent = new Date(now.getTime() - 86_400_000).toISOString();
    await db.studiesHistory.bulkAdd([
      { study_id: 's1', observed_at: old, payload: { reward: { amount: 500, currency: 'GBP' } } },
      { study_id: 's1', observed_at: recent, payload: { reward: { amount: 500, currency: 'GBP' } } },
    ]);
    await store.pruneStudyHistory(now);
    const remaining = await db.studiesHistory.toArray();
    expect(remaining.map((r) => r.observed_at)).toEqual([recent]);
  });

  it('ages out old observation-log heartbeats past the retention window', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const old = new Date(now.getTime() - 200 * 86_400_000).toISOString();
    const recent = new Date(now.getTime() - 86_400_000).toISOString();
    await store.recordObservation(old);
    await store.recordObservation(recent);
    await store.pruneStudyHistory(now);
    const remaining = await db.observationLog.toArray();
    expect(remaining.map((o) => o.at)).toEqual([recent]);
  });
});

describe('pruneStudyHistoryToRowCap', () => {
  const seed = async (n: number) => {
    const rows = Array.from({ length: n }, (_v, i) => ({
      study_id: `s${i}`,
      observed_at: `2026-03-01T00:00:${String(i).padStart(2, '0')}Z`,
      payload: { reward: { amount: 100 + i, currency: 'GBP' } },
    }));
    await db.studiesHistory.bulkAdd(rows);
  };

  it('drops the oldest rows so only the cap remains, keeping the newest', async () => {
    await seed(10);
    const deleted = await store.pruneStudyHistoryToRowCap(4);
    expect(deleted).toBe(6);
    const remaining = await db.studiesHistory.orderBy('row_id').toArray();
    expect(remaining).toHaveLength(4);
    // The newest four (studies s6..s9) survive; oldest six are gone.
    expect(remaining.map((r) => r.study_id)).toEqual(['s6', 's7', 's8', 's9']);
  });

  it('is a no-op when already at/under the cap', async () => {
    await seed(3);
    expect(await store.pruneStudyHistoryToRowCap(5)).toBe(0);
    expect(await store.pruneStudyHistoryToRowCap(3)).toBe(0);
    expect(await db.studiesHistory.count()).toBe(3);
  });

  it('clamps a negative/fractional cap to a safe integer floor', async () => {
    await seed(4);
    const deleted = await store.pruneStudyHistoryToRowCap(-1);
    expect(deleted).toBe(4);
    expect(await db.studiesHistory.count()).toBe(0);
  });

  it('handles an empty table without throwing', async () => {
    expect(await store.pruneStudyHistoryToRowCap(100)).toBe(0);
  });
});
