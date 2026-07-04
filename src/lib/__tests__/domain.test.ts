import { describe, it, expect } from 'vitest';
import {
  studyMatchesPriorityFilter,
  studyKeywordBlob,
  evaluatePrioritySnapshotEvent,
} from '../../entrypoints/background/domain';
import type { Study, PriorityFilter } from '../types';
import { SOUND_TYPE_NONE } from '../constants';

// ── Helpers ──────────────────────────────────────────────────────

function makeStudy(overrides: Partial<Study> = {}): Study {
  return {
    id: 'study-1',
    name: 'Test Study',
    study_type: 'SINGLE',
    date_created: '2025-01-01T00:00:00Z',
    published_at: '2025-01-01T00:00:00Z',
    total_available_places: 100,
    places_taken: 0,
    places_available: 100,
    reward: { amount: 500, currency: 'GBP' },
    average_reward_per_hour: { amount: 1200, currency: 'GBP' },
    max_submissions_per_participant: 1,
    researcher: { id: 'r1', name: 'Dr. Smith', country: 'GB' },
    description: 'A test study about surveys.',
    estimated_completion_time: 10,
    device_compatibility: ['desktop'],
    peripheral_requirements: [],
    maximum_allowed_time: 60,
    average_completion_time_in_seconds: 600,
    is_confidential: false,
    is_ongoing_study: false,
    pii_enabled: false,
    is_custom_screening: false,
    study_labels: [],
    ai_inferred_study_labels: [],
    previous_submission_count: 0,
    ...overrides,
  };
}

function makeFilter(overrides: Partial<PriorityFilter> = {}): PriorityFilter {
  return {
    id: 'filter-1',
    name: 'Test Filter',
    enabled: true,
    auto_open_in_new_tab: true,
    alert_sound_enabled: true,
    alert_sound_type: 'pay',
    alert_sound_volume: 100,
    telegram_notify: true,
    desktop_notify: false,
    quiet_hours_enabled: false,
    quiet_hours_start: '23:00',
    quiet_hours_end: '07:00',
    minimum_reward_major: 0,
    minimum_hourly_reward_major: 0,
    maximum_estimated_minutes: 240,
    minimum_places_available: 1,
    match_keywords: [],
    ignore_keywords: [],
    match_researchers: [],
    ignore_researchers: [],
    ...overrides,
  };
}

function makeFullEvent(studies: Study[]) {
  return {
    mode: 'full' as const,
    trigger: 'test',
    observedAtMS: Date.now(),
    studies,
    removedStudyIDs: [],
  };
}

// ── studyMatchesPriorityFilter ───────────────────────────────────

describe('studyMatchesPriorityFilter', () => {
  it('matches study meeting all numeric criteria', () => {
    const study = makeStudy({ reward: { amount: 500, currency: 'GBP' }, average_reward_per_hour: { amount: 1200, currency: 'GBP' } });
    const filter = makeFilter({ minimum_reward_major: 3, minimum_hourly_reward_major: 8 });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(true);
  });

  it('rejects study below minimum reward', () => {
    const study = makeStudy({ reward: { amount: 100, currency: 'GBP' } });
    const filter = makeFilter({ minimum_reward_major: 5 });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('rejects study below minimum hourly reward', () => {
    const study = makeStudy({ average_reward_per_hour: { amount: 500, currency: 'GBP' } });
    const filter = makeFilter({ minimum_hourly_reward_major: 10 });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('rejects study exceeding max estimated minutes', () => {
    const study = makeStudy({ estimated_completion_time: 30 });
    const filter = makeFilter({ maximum_estimated_minutes: 20 });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('rejects study with too few places available', () => {
    const study = makeStudy({ places_available: 2 });
    const filter = makeFilter({ minimum_places_available: 5 });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('match_keywords scope the filter to studies containing at least one', () => {
    const matching = makeStudy({ name: 'AI Research Survey' });
    const other = makeStudy({ name: 'Generic Study' });
    const filter = makeFilter({ match_keywords: ['ai research'] });
    expect(studyMatchesPriorityFilter(matching, filter)).toBe(true);
    expect(studyMatchesPriorityFilter(other, filter)).toBe(false);
  });

  it('match_keywords scoping still enforces numeric criteria', () => {
    const lowPay = makeStudy({ name: 'AI Research Survey', reward: { amount: 50, currency: 'GBP' } });
    const filter = makeFilter({ minimum_reward_major: 100, match_keywords: ['ai research'] });
    expect(studyMatchesPriorityFilter(lowPay, filter)).toBe(false);
  });

  it('rejects via ignore_keywords even if numerics match', () => {
    const study = makeStudy({ name: 'Webcam Required Study', reward: { amount: 5000, currency: 'GBP' } });
    const filter = makeFilter({ ignore_keywords: ['webcam'] });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('ignore_keywords take precedence over match_keywords', () => {
    const study = makeStudy({ name: 'AI Webcam Study' });
    const filter = makeFilter({ match_keywords: ['ai'], ignore_keywords: ['webcam'] });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('matches keywords in description', () => {
    const study = makeStudy({ name: 'Generic', description: 'This study involves mobile testing' });
    const filter = makeFilter({ match_keywords: ['mobile'] });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(true);
  });

  it('matches keywords in study_labels', () => {
    const study = makeStudy({ study_labels: ['Psychology', 'Cognition'] });
    const filter = makeFilter({ match_keywords: ['cognition'] });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(true);
  });

  it('accepts precomputedBlob parameter', () => {
    const study = makeStudy({ name: 'Special Study' });
    const blob = studyKeywordBlob(study);
    const filter = makeFilter({ match_keywords: ['special'] });
    expect(studyMatchesPriorityFilter(study, filter, blob)).toBe(true);
  });

  it('handles study with estimated_completion_time 0 using fallback', () => {
    const study = makeStudy({
      estimated_completion_time: 0,
      average_completion_time_in_seconds: 300,
    });
    const filter = makeFilter({ maximum_estimated_minutes: 10 });
    // 0 is treated as valid (0 minutes), which is <= 10
    expect(studyMatchesPriorityFilter(study, filter)).toBe(true);
  });

  it('handles study with no places_available using total - taken', () => {
    const raw = makeStudy({ total_available_places: 50, places_taken: 45 }) as any;
    delete raw.places_available;
    const filter = makeFilter({ minimum_places_available: 5 });
    expect(studyMatchesPriorityFilter(raw as Study, filter)).toBe(true);
  });

  it('match_researchers scope the filter to matching researchers', () => {
    const matching = makeStudy({ researcher: { id: 'r-42', name: 'Oxford Lab', country: 'GB' } });
    const other = makeStudy({ researcher: { id: 'r-other', name: 'Some Other Lab', country: 'GB' } });
    const filter = makeFilter({ match_researchers: [{ id: 'r-42', name: 'Oxford Lab' }] });
    expect(studyMatchesPriorityFilter(matching, filter)).toBe(true);
    expect(studyMatchesPriorityFilter(other, filter)).toBe(false);
  });

  it('match_researchers scoping still enforces numeric criteria', () => {
    const lowPay = makeStudy({
      researcher: { id: 'r-42', name: 'Oxford Lab', country: 'GB' },
      reward: { amount: 50, currency: 'GBP' },
    });
    const filter = makeFilter({
      minimum_reward_major: 100,
      match_researchers: [{ id: 'r-42', name: 'Oxford Lab' }],
    });
    expect(studyMatchesPriorityFilter(lowPay, filter)).toBe(false);
  });

  it('match lists combine as OR: researcher match alone is enough', () => {
    const study = makeStudy({
      name: 'Generic',
      researcher: { id: 'r-42', name: 'Oxford Lab', country: 'GB' },
    });
    const filter = makeFilter({
      match_keywords: ['ai'],
      match_researchers: [{ id: 'r-42', name: 'Oxford Lab' }],
    });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(true);
  });

  it('match lists combine as OR: keyword match alone is enough', () => {
    const study = makeStudy({
      name: 'AI Survey',
      researcher: { id: 'r-other', name: 'Other Lab', country: 'GB' },
    });
    const filter = makeFilter({
      match_keywords: ['ai'],
      match_researchers: [{ id: 'r-42', name: 'Oxford Lab' }],
    });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(true);
  });

  it('rejects when match lists are non-empty and neither matches', () => {
    const study = makeStudy({
      name: 'Generic',
      researcher: { id: 'r-other', name: 'Other Lab', country: 'GB' },
    });
    const filter = makeFilter({
      match_keywords: ['ai'],
      match_researchers: [{ id: 'r-42', name: 'Oxford Lab' }],
    });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('rejects via ignore_researchers even if numerics match', () => {
    const study = makeStudy({
      researcher: { id: 'r-bad', name: 'Spammy', country: 'GB' },
      reward: { amount: 5000, currency: 'GBP' },
    });
    const filter = makeFilter({
      ignore_researchers: [{ id: 'r-bad', name: 'Spammy' }],
    });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('ignore_researchers take precedence over match_keywords', () => {
    const study = makeStudy({
      name: 'AI Survey',
      researcher: { id: 'r-bad', name: 'Spammy', country: 'GB' },
    });
    const filter = makeFilter({
      match_keywords: ['ai'],
      ignore_researchers: [{ id: 'r-bad', name: 'Spammy' }],
    });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('ignore_keywords take precedence over match_researchers', () => {
    const study = makeStudy({
      name: 'Webcam Study',
      researcher: { id: 'r-good', name: 'Good Lab', country: 'GB' },
    });
    const filter = makeFilter({
      match_researchers: [{ id: 'r-good', name: 'Good Lab' }],
      ignore_keywords: ['webcam'],
    });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });

  it('researcher match uses id only, ignoring stored name mismatches', () => {
    const study = makeStudy({
      researcher: { id: 'r-1', name: 'Current Name', country: 'GB' },
    });
    const filter = makeFilter({
      match_researchers: [{ id: 'r-1', name: 'Old Stored Name' }],
    });
    expect(studyMatchesPriorityFilter(study, filter)).toBe(true);
  });

  it('empty-id researcher entries do not match a study with an empty id', () => {
    const study = makeStudy({
      researcher: { id: '', name: 'Nameless', country: '' },
    });
    const filter = makeFilter({
      match_researchers: [{ id: '', name: 'Nameless' }],
    });
    // Non-empty match_researchers list + no matching id → filter rejects.
    expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
  });
});

// ── studyKeywordBlob ─────────────────────────────────────────────

describe('studyKeywordBlob', () => {
  it('combines name, description, labels into lowercase blob', () => {
    const study = makeStudy({
      name: 'AI Survey',
      description: 'About Machine Learning',
      study_labels: ['Tech'],
      ai_inferred_study_labels: ['Research'],
    });
    const blob = studyKeywordBlob(study);
    expect(blob).toContain('ai survey');
    expect(blob).toContain('about machine learning');
    expect(blob).toContain('tech');
    expect(blob).toContain('research');
  });

  it('returns empty-ish string for null study', () => {
    const blob = studyKeywordBlob(null);
    expect(blob.trim()).toBe('');
  });
});

// ── evaluatePrioritySnapshotEvent (multi-filter) ─────────────────

describe('evaluatePrioritySnapshotEvent', () => {
  it('baseline event produces no matches', () => {
    const study = makeStudy();
    const filter = makeFilter({ enabled: true });
    const result = evaluatePrioritySnapshotEvent(null, makeFullEvent([study]), [filter]);
    expect(result.isBaseline).toBe(true);
    expect(result.matchesByFilterId.size).toBe(0);
  });

  it('second full snapshot detects new studies', () => {
    const study1 = makeStudy({ id: 's1' });
    const study2 = makeStudy({ id: 's2' });
    const filter = makeFilter({ enabled: true });

    // First: baseline
    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([study1]), [filter]);
    expect(r1.isBaseline).toBe(true);

    // Second: s2 is new
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([study1, study2]), [filter]);
    expect(r2.isBaseline).toBe(false);
    expect(r2.newlySeenStudies).toHaveLength(1);
    expect(r2.newlySeenStudies[0].id).toBe('s2');
    expect(r2.matchesByFilterId.get(filter.id)).toHaveLength(1);
  });

  it('disabled filters produce no matches', () => {
    const study = makeStudy({ id: 's1' });
    const filter = makeFilter({ enabled: false });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([study]), [filter]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([study, makeStudy({ id: 's2' })]), [filter]);
    expect(r2.matchesByFilterId.size).toBe(0);
    expect(r2.enabledFilters).toHaveLength(0);
  });

  it('study rejected by filter criteria produces no match', () => {
    const study = makeStudy({ id: 's2', reward: { amount: 50, currency: 'GBP' } });
    const filter = makeFilter({ enabled: true, minimum_reward_major: 10 });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's1' })]), [filter]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's1' }), study]), [filter]);
    expect(r2.matchesByFilterId.size).toBe(0);
  });

  // ── Conflict resolution ────────────────────────────────────────

  it('assigns study to exactly one filter when multiple match', () => {
    const study = makeStudy({ id: 's2', reward: { amount: 1000, currency: 'GBP' }, average_reward_per_hour: { amount: 2000, currency: 'GBP' } });
    const filterA = makeFilter({ id: 'a', name: 'Low bar', enabled: true, minimum_reward_major: 0 });
    const filterB = makeFilter({ id: 'b', name: 'High bar', enabled: true, minimum_reward_major: 5 });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's1' })]), [filterA, filterB]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's1' }), study]), [filterA, filterB]);

    // Study appears under exactly one filter
    const allMatched = [...r2.matchesByFilterId.values()].flat();
    expect(allMatched).toHaveLength(1);
    expect(allMatched[0].id).toBe('s2');
  });

  it('keyword filter wins over numeric-only filter', () => {
    const study = makeStudy({ id: 's2', name: 'Dr. Smith AI Research' });
    const numericFilter = makeFilter({
      id: 'numeric',
      enabled: true,
      alert_sound_volume: 100,
      auto_open_in_new_tab: true,
    });
    const keywordFilter = makeFilter({
      id: 'keyword',
      enabled: true,
      match_keywords: ['dr. smith'],
      alert_sound_volume: 50,
      auto_open_in_new_tab: false,
    });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's1' })]), [numericFilter, keywordFilter]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's1' }), study]), [numericFilter, keywordFilter]);

    // Keyword filter should win despite lower volume and no auto-open
    expect(r2.matchesByFilterId.has('keyword')).toBe(true);
    expect(r2.matchesByFilterId.has('numeric')).toBe(false);
  });

  it('filter with auto-open+sound wins over silent filter when no keywords', () => {
    const study = makeStudy({ id: 's2' });
    const silentFilter = makeFilter({
      id: 'silent',
      enabled: true,
      alert_sound_enabled: false,
      alert_sound_type: SOUND_TYPE_NONE,
      auto_open_in_new_tab: false,
    });
    const loudFilter = makeFilter({
      id: 'loud',
      enabled: true,
      alert_sound_enabled: true,
      alert_sound_type: 'pay',
      alert_sound_volume: 100,
      auto_open_in_new_tab: true,
    });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's1' })]), [silentFilter, loudFilter]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's1' }), study]), [silentFilter, loudFilter]);

    expect(r2.matchesByFilterId.has('loud')).toBe(true);
    expect(r2.matchesByFilterId.has('silent')).toBe(false);
  });

  it('earlier filter wins when scores are equal', () => {
    const study = makeStudy({ id: 's2' });
    const filterA = makeFilter({ id: 'first', enabled: true });
    const filterB = makeFilter({ id: 'second', enabled: true });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's1' })]), [filterA, filterB]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's1' }), study]), [filterA, filterB]);

    expect(r2.matchesByFilterId.has('first')).toBe(true);
    expect(r2.matchesByFilterId.has('second')).toBe(false);
  });

  it('stricter filter wins over permissive filter', () => {
    const study = makeStudy({ id: 's2', reward: { amount: 1000, currency: 'GBP' }, average_reward_per_hour: { amount: 2000, currency: 'GBP' } });
    const permissive = makeFilter({
      id: 'permissive',
      enabled: true,
      minimum_reward_major: 0,
      minimum_hourly_reward_major: 0,
      auto_open_in_new_tab: false,
      alert_sound_enabled: false,
      alert_sound_type: SOUND_TYPE_NONE,
      alert_sound_volume: 0,
    });
    const strict = makeFilter({
      id: 'strict',
      enabled: true,
      minimum_reward_major: 5,
      minimum_hourly_reward_major: 15,
      maximum_estimated_minutes: 15,
      auto_open_in_new_tab: false,
      alert_sound_enabled: false,
      alert_sound_type: SOUND_TYPE_NONE,
      alert_sound_volume: 0,
    });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's1' })]), [permissive, strict]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's1' }), study]), [permissive, strict]);

    expect(r2.matchesByFilterId.has('strict')).toBe(true);
    expect(r2.matchesByFilterId.has('permissive')).toBe(false);
  });

  it('different studies can go to different filters', () => {
    const aiStudy = makeStudy({
      id: 'ai', name: 'AI Research',
      reward: { amount: 500, currency: 'GBP' }, average_reward_per_hour: { amount: 1200, currency: 'GBP' },
    });
    const highPayStudy = makeStudy({
      id: 'pay', name: 'Generic',
      reward: { amount: 2000, currency: 'GBP' }, average_reward_per_hour: { amount: 3000, currency: 'GBP' },
    });

    // Scoped filter: only matches AI studies (and permissive numerics).
    const keywordFilter = makeFilter({
      id: 'kw',
      enabled: true,
      match_keywords: ['ai research'],
    });
    // Open filter: matches everything ≥ $10 reward.
    const numericFilter = makeFilter({
      id: 'num',
      enabled: true,
      minimum_reward_major: 10,
    });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's0' })]), [keywordFilter, numericFilter]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's0' }), aiStudy, highPayStudy]), [keywordFilter, numericFilter]);

    // AI study → keyword filter (scoped filters beat open filters in score).
    expect(r2.matchesByFilterId.get('kw')?.map((s) => s.id)).toEqual(['ai']);
    // High-pay study doesn't match kw's scope; falls through to numeric filter.
    expect(r2.matchesByFilterId.get('num')?.map((s) => s.id)).toEqual(['pay']);
  });

  it('researcher always-open filter wins over numeric-only filter', () => {
    const study = makeStudy({
      id: 's2',
      researcher: { id: 'r-fav', name: 'Favourite Lab', country: 'GB' },
    });
    const numericFilter = makeFilter({
      id: 'numeric',
      enabled: true,
      alert_sound_volume: 100,
      auto_open_in_new_tab: true,
    });
    const researcherFilter = makeFilter({
      id: 'researcher',
      enabled: true,
      match_researchers: [{ id: 'r-fav', name: 'Favourite Lab' }],
      alert_sound_volume: 50,
      auto_open_in_new_tab: false,
    });

    const r1 = evaluatePrioritySnapshotEvent(null, makeFullEvent([makeStudy({ id: 's1' })]), [numericFilter, researcherFilter]);
    const r2 = evaluatePrioritySnapshotEvent(r1.nextSnapshot, makeFullEvent([makeStudy({ id: 's1' }), study]), [numericFilter, researcherFilter]);

    expect(r2.matchesByFilterId.has('researcher')).toBe(true);
    expect(r2.matchesByFilterId.has('numeric')).toBe(false);
  });

  it('enabledFilters is returned in result', () => {
    const filterA = makeFilter({ id: 'a', enabled: true });
    const filterB = makeFilter({ id: 'b', enabled: false });
    const filterC = makeFilter({ id: 'c', enabled: true });

    const result = evaluatePrioritySnapshotEvent(null, makeFullEvent([]), [filterA, filterB, filterC]);
    expect(result.enabledFilters).toHaveLength(2);
    expect(result.enabledFilters[0].filter.id).toBe('a');
    expect(result.enabledFilters[0].index).toBe(0);
    expect(result.enabledFilters[1].filter.id).toBe('c');
    expect(result.enabledFilters[1].index).toBe(2);
  });
});
