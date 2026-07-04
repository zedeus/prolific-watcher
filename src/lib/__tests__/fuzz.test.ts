/**
 * Chaos/fuzz tests for the researcher-lists feature. Hammers the pure
 * functions with malformed and random inputs and verifies invariants rather
 * than specific outputs.
 */
import { describe, it, expect } from 'vitest';
import { studyMatchesPriorityFilter } from '../../entrypoints/background/domain';
import { createPrioritySettings } from '../../entrypoints/background/settings';
import {
  extractResearcherFromSubmissionPayload,
  annotateResearcherCounts,
} from '../store';
import { createDefaultPriorityFilter } from '../priority-filter';
import type { Study, PriorityFilter, ResearcherRef } from '../types';
import type { ResearcherRecord, SubmissionRecord } from '../db';
import { SOUND_TYPE_NONE, MAX_PRIORITY_FILTER_RESEARCHERS, MAX_PRIORITY_FILTER_KEYWORDS } from '../constants';

import { makeRng, pick as pickFromArr } from '../__dev__/rng';

// Convenience wrapper to flip pick's arg order so it reads more naturally in
// long chains (`pick(rng, [...])` vs `pick([...], rng)`).
function pick<T>(rng: () => number, arr: readonly T[]): T {
  return pickFromArr(arr, rng);
}

// ── Garbage-shape generators ─────────────────────────────────────
const GARBAGE_VALUES: readonly unknown[] = [
  null, undefined, '', 0, -1, NaN, Infinity, -Infinity,
  true, false, [], {}, 'nope', '0', '1.5', '   ',
  { id: null }, { name: null }, { id: 123, name: true },
  [1, 2, 3], new Date(),
];

function randomString(rng: () => number, maxLen = 40): string {
  const len = Math.floor(rng() * maxLen);
  const charset = 'abc  · ÄÉÖ🎉<>&"\\\n\t';
  let out = '';
  for (let i = 0; i < len; i++) out += pick(rng, [...charset]);
  return out;
}

function randomMoney(rng: () => number) {
  // Occasionally garbage.
  if (rng() < 0.1) return pick(rng, GARBAGE_VALUES);
  return {
    amount: rng() < 0.05 ? pick(rng, GARBAGE_VALUES) : Math.floor(rng() * 10000),
    currency: pick(rng, ['GBP', 'USD', 'EUR', '', '!!!']),
  };
}

function randomResearcher(rng: () => number): unknown {
  if (rng() < 0.15) return pick(rng, GARBAGE_VALUES);
  return {
    id: rng() < 0.3 ? pick(rng, ['', '  ', 'r-' + Math.floor(rng() * 100), pick(rng, GARBAGE_VALUES)]) : `r-${Math.floor(rng() * 100)}`,
    name: rng() < 0.2 ? pick(rng, GARBAGE_VALUES) : randomString(rng),
    country: rng() < 0.2 ? pick(rng, GARBAGE_VALUES) : pick(rng, ['GB', 'US', '', 'XX']),
  };
}

function randomStudy(rng: () => number): Study {
  // Mostly valid but sometimes garbage in various fields.
  return {
    id: `s-${Math.floor(rng() * 1000)}`,
    name: randomString(rng),
    study_type: 'SINGLE',
    date_created: '2025-01-01',
    published_at: '2025-01-01',
    total_available_places: Math.floor(rng() * 200),
    places_taken: Math.floor(rng() * 100),
    places_available: Math.floor(rng() * 100),
    reward: randomMoney(rng) as { amount: number; currency: string },
    average_reward_per_hour: randomMoney(rng) as { amount: number; currency: string },
    max_submissions_per_participant: 1,
    researcher: randomResearcher(rng) as Study['researcher'],
    description: randomString(rng, 200),
    estimated_completion_time: rng() < 0.1 ? (pick(rng, GARBAGE_VALUES) as number) : Math.floor(rng() * 120),
    device_compatibility: [],
    peripheral_requirements: [],
    maximum_allowed_time: 60,
    average_completion_time_in_seconds: 600,
    is_confidential: false,
    is_ongoing_study: false,
    pii_enabled: false,
    is_custom_screening: false,
    study_labels: rng() < 0.1 ? (null as unknown as string[]) : [randomString(rng, 15)],
    ai_inferred_study_labels: [],
    previous_submission_count: 0,
  };
}

function randomFilter(rng: () => number): PriorityFilter {
  const mkList = <T>(max: number, mkItem: () => T): T[] => {
    const n = Math.floor(rng() * max);
    return Array.from({ length: n }, mkItem);
  };
  return createDefaultPriorityFilter({
    minimum_reward_major: rng() < 0.1 ? (pick(rng, GARBAGE_VALUES) as number) : Math.floor(rng() * 20),
    minimum_hourly_reward_major: Math.floor(rng() * 30),
    maximum_estimated_minutes: 1 + Math.floor(rng() * 200),
    minimum_places_available: Math.floor(rng() * 10),
    match_keywords: mkList(8, () => randomString(rng, 8).toLowerCase()),
    ignore_keywords: mkList(8, () => randomString(rng, 8).toLowerCase()),
    match_researchers: mkList<ResearcherRef>(5, () => ({ id: `r-${Math.floor(rng() * 100)}`, name: randomString(rng) })),
    ignore_researchers: [],
    alert_sound_type: pick(rng, ['pay', 'chime', SOUND_TYPE_NONE]),
    alert_sound_volume: Math.floor(rng() * 101),
    alert_sound_enabled: rng() > 0.2,
  });
}

// ── Tests ────────────────────────────────────────────────────────

describe('fuzz: studyMatchesPriorityFilter', () => {
  it('never throws and always returns a boolean for 5000 random inputs', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 5000; i++) {
      const study = randomStudy(rng);
      const filter = randomFilter(rng);
      const result = studyMatchesPriorityFilter(study, filter);
      expect(typeof result).toBe('boolean');
    }
  });

  it('handles null/undefined researcher on study without throwing', () => {
    const filter = createDefaultPriorityFilter({
      match_researchers: [{ id: 'r-1', name: 'X' }],
    });
    const base = randomStudy(makeRng(2));
    // Each of these is intentionally malformed; function must not throw.
    const shapes: Array<Partial<Study>> = [
      { researcher: null as unknown as Study['researcher'] },
      { researcher: undefined as unknown as Study['researcher'] },
      { researcher: {} as Study['researcher'] },
      { researcher: { id: '', name: '', country: '' } },
      { researcher: { id: '   ', name: 'Trimmed', country: '' } },
    ];
    for (const override of shapes) {
      const s = { ...base, ...override } as Study;
      expect(() => studyMatchesPriorityFilter(s, filter)).not.toThrow();
    }
  });

  it('match lists with duplicate ids behave the same as deduped', () => {
    const base = randomStudy(makeRng(3));
    const study: Study = { ...base, researcher: { id: 'r-x', name: 'X', country: '' } };
    const duped = createDefaultPriorityFilter({
      match_researchers: [
        { id: 'r-x', name: 'X' },
        { id: 'r-x', name: 'X' },
        { id: 'r-x', name: 'different name' },
      ],
    });
    const deduped = createDefaultPriorityFilter({
      match_researchers: [{ id: 'r-x', name: 'X' }],
    });
    expect(studyMatchesPriorityFilter(study, duped)).toBe(studyMatchesPriorityFilter(study, deduped));
  });

  it('ignore always beats match regardless of list ordering', () => {
    const rng = makeRng(4);
    for (let i = 0; i < 200; i++) {
      const id = `r-${Math.floor(rng() * 10)}`;
      const base = randomStudy(rng);
      const study: Study = { ...base, researcher: { id, name: 'x', country: '' } };
      const filter = createDefaultPriorityFilter({
        match_researchers: [{ id, name: 'x' }],
        ignore_researchers: [{ id, name: 'x' }],
      });
      expect(studyMatchesPriorityFilter(study, filter)).toBe(false);
    }
  });
});

describe('fuzz: normalizePriorityFilter', () => {
  const { normalizePriorityFilter, normalizePriorityFilters } = createPrioritySettings({
    limits: {
      maxKeywords: MAX_PRIORITY_FILTER_KEYWORDS,
      maxMinReward: 100, minMinReward: 0,
      maxMinHourlyReward: 100, minMinHourlyReward: 0,
      maxEstimatedMinutes: 240, minEstimatedMinutes: 1,
      maxMinimumPlaces: 1000, minMinimumPlaces: 1,
      maxAlertSoundVolume: 100, minAlertSoundVolume: 0,
    },
    defaults: {
      minimumRewardMajor: 0,
      minimumHourlyRewardMajor: 0,
      maximumEstimatedMinutes: 240,
      minimumPlacesAvailable: 1,
      alertSoundType: 'pay',
      alertSoundVolume: 100,
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
    },
  });

  it('returns a valid-shaped filter for 500 random garbage inputs', () => {
    const rng = makeRng(5);
    for (let i = 0; i < 500; i++) {
      const raw = pick(rng, GARBAGE_VALUES);
      const filter = normalizePriorityFilter(raw);
      expect(typeof filter.id).toBe('string');
      expect(filter.id.length).toBeGreaterThan(0);
      expect(Array.isArray(filter.match_keywords)).toBe(true);
      expect(Array.isArray(filter.ignore_keywords)).toBe(true);
      expect(Array.isArray(filter.match_researchers)).toBe(true);
      expect(Array.isArray(filter.ignore_researchers)).toBe(true);
      expect(typeof filter.enabled).toBe('boolean');
      expect(typeof filter.desktop_notify).toBe('boolean');
      expect(typeof filter.quiet_hours_enabled).toBe('boolean');
      expect(typeof filter.quiet_hours_start).toBe('string');
      expect(filter.quiet_hours_start).toMatch(/^\d{1,2}:\d{2}$/);
      expect(typeof filter.quiet_hours_end).toBe('string');
      expect(filter.quiet_hours_end).toMatch(/^\d{1,2}:\d{2}$/);
      expect(typeof filter.minimum_reward_major).toBe('number');
      expect(Number.isFinite(filter.minimum_reward_major)).toBe(true);
    }
  });

  it('caps researcher lists at MAX_PRIORITY_FILTER_RESEARCHERS', () => {
    const overflow = Array.from({ length: MAX_PRIORITY_FILTER_RESEARCHERS + 10 }, (_, i) => ({
      id: `r-${i}`, name: `Name ${i}`,
    }));
    const filter = normalizePriorityFilter({ match_researchers: overflow, ignore_researchers: overflow });
    expect(filter.match_researchers.length).toBe(MAX_PRIORITY_FILTER_RESEARCHERS);
    expect(filter.ignore_researchers.length).toBe(MAX_PRIORITY_FILTER_RESEARCHERS);
  });

  it('caps keyword lists at MAX_PRIORITY_FILTER_KEYWORDS', () => {
    const overflow = Array.from({ length: MAX_PRIORITY_FILTER_KEYWORDS + 10 }, (_, i) => `kw${i}`);
    const filter = normalizePriorityFilter({ match_keywords: overflow, ignore_keywords: overflow });
    expect(filter.match_keywords.length).toBe(MAX_PRIORITY_FILTER_KEYWORDS);
    expect(filter.ignore_keywords.length).toBe(MAX_PRIORITY_FILTER_KEYWORDS);
  });

  it('dedupes researcher lists by trimmed id', () => {
    const filter = normalizePriorityFilter({
      match_researchers: [
        { id: 'r-1', name: 'A' },
        { id: 'r-1', name: 'A again' },
        { id: '  r-1  ', name: 'padded' },
        { id: 'r-2', name: 'B' },
        { id: '', name: 'empty id' },
      ],
    });
    expect(filter.match_researchers.map((r) => r.id)).toEqual(['r-1', 'r-2']);
  });

  it('filters out non-object entries silently', () => {
    const filter = normalizePriorityFilter({
      match_researchers: [null, 'string', 42, undefined, { id: 'r-1', name: 'OK' }, { name: 'no id' }],
    });
    expect(filter.match_researchers).toEqual([{ id: 'r-1', name: 'OK' }]);
  });

  it('normalizePriorityFilters handles garbage arrays without throwing', () => {
    const rng = makeRng(6);
    for (let i = 0; i < 200; i++) {
      const raw = pick(rng, GARBAGE_VALUES);
      const result = normalizePriorityFilters(raw);
      expect(Array.isArray(result)).toBe(true);
    }
  });

  it('accepts mixed old (always_open_*) and new (match_*) field names', () => {
    // New field takes precedence.
    const bothKeywords = normalizePriorityFilter({
      match_keywords: ['new'],
      always_open_keywords: ['old'],
    });
    expect(bothKeywords.match_keywords).toEqual(['new']);
    // Legacy field only → migrated.
    const legacyOnly = normalizePriorityFilter({
      always_open_researchers: [{ id: 'r-1', name: 'Lab' }],
    });
    expect(legacyOnly.match_researchers).toEqual([{ id: 'r-1', name: 'Lab' }]);
  });
});

describe('fuzz: extractResearcherFromSubmissionPayload', () => {
  it('returns null or a valid researcher for 500 random garbage inputs', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const payload = pick(rng, GARBAGE_VALUES);
      const result = extractResearcherFromSubmissionPayload(payload);
      if (result !== null) {
        expect(typeof result.id).toBe('string');
        expect(result.id.length).toBeGreaterThan(0);
        expect(typeof result.name).toBe('string');
        expect(typeof result.country).toBe('string');
      }
    }
  });

  it('rejects empty or whitespace-only researcher ids', () => {
    expect(extractResearcherFromSubmissionPayload({ study: { researcher: { id: '' } } })).toBeNull();
    expect(extractResearcherFromSubmissionPayload({ study: { researcher: { id: '   ' } } })).toBeNull();
    expect(extractResearcherFromSubmissionPayload({ researcher: { id: 'r-1' } })).toEqual({ id: 'r-1', name: '', country: '' });
  });

  it('prefers nested study.researcher over top-level researcher', () => {
    const result = extractResearcherFromSubmissionPayload({
      researcher: { id: 'top', name: 'Top' },
      study: { researcher: { id: 'nested', name: 'Nested' } },
    });
    expect(result?.id).toBe('nested');
  });
});

describe('fuzz: annotateResearcherCounts', () => {
  const mkRecord = (id: string): ResearcherRecord => ({
    id, name: `Name ${id}`, country: 'GB',
    first_seen_at: '2025-01-01T00:00:00Z',
    last_seen_at: '2025-01-01T00:00:00Z',
    study_count: 99, submission_count: 99,
  });

  it('returns array of same length with non-negative counts', () => {
    const rng = makeRng(8);
    for (let i = 0; i < 100; i++) {
      const researchers = Array.from({ length: Math.floor(rng() * 20) }, (_, i) => mkRecord(`r-${i}`));
      const studies = Array.from({ length: Math.floor(rng() * 50) }, () => randomStudy(rng));
      const submissions: SubmissionRecord[] = [];
      const result = annotateResearcherCounts(researchers, studies, submissions);
      expect(result.length).toBe(researchers.length);
      for (const r of result) {
        expect(r.study_count).toBeGreaterThanOrEqual(0);
        expect(r.submission_count).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('computes accurate counts for known researchers', () => {
    const researchers = [mkRecord('r-1'), mkRecord('r-2')];
    const studies = [
      { researcher: { id: 'r-1', name: 'A', country: '' } },
      { researcher: { id: 'r-1', name: 'A', country: '' } },
      { researcher: { id: 'r-2', name: 'B', country: '' } },
      { researcher: { id: 'r-nobody', name: 'C', country: '' } },
    ] as Study[];
    const submissions: SubmissionRecord[] = [
      {
        submission_id: 's1', study_id: 'x', study_name: '', participant_id: '', status: 'APPROVED', phase: 'submitted',
        payload: { study: { researcher: { id: 'r-1' } } }, observed_at: '', updated_at: '',
      },
    ];
    const result = annotateResearcherCounts(researchers, studies, submissions);
    expect(result.find((r) => r.id === 'r-1')).toMatchObject({ study_count: 2, submission_count: 1 });
    expect(result.find((r) => r.id === 'r-2')).toMatchObject({ study_count: 1, submission_count: 0 });
  });

  it('overwrites any stale counts on the input records', () => {
    const records = [mkRecord('r-1')]; // seeded with study_count=99
    const result = annotateResearcherCounts(records, [], []);
    expect(result[0].study_count).toBe(0);
    expect(result[0].submission_count).toBe(0);
  });

  it('does not mutate the input record objects', () => {
    const record = mkRecord('r-1');
    const original = { ...record };
    annotateResearcherCounts([record], [], []);
    expect(record).toEqual(original);
  });

  it('tolerates garbage-shaped study/submission entries', () => {
    const records = [mkRecord('r-1')];
    const studies = [
      null, undefined, {}, { researcher: null }, { researcher: {} },
      { researcher: { id: 42 } }, { researcher: { id: '   ' } },
      { researcher: { id: 'r-1' } }, // valid; should count once
    ] as unknown as Study[];
    const submissions = [
      { payload: null },
      { payload: 'not-an-object' },
      { payload: { study: { researcher: { id: 42 } } } },
      { payload: { study: { researcher: { id: 'r-1' } } } }, // valid
    ] as unknown as SubmissionRecord[];
    let result: ResearcherRecord[] = [];
    expect(() => { result = annotateResearcherCounts(records, studies, submissions); }).not.toThrow();
    expect(result[0]).toMatchObject({ study_count: 1, submission_count: 1 });
  });
});

describe('fuzz: createDefaultPriorityFilter', () => {
  it('produces unique ids across 1000 calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(createDefaultPriorityFilter().id);
    expect(ids.size).toBe(1000);
  });

  it('overrides replace defaults, not merge into lists', () => {
    const f = createDefaultPriorityFilter({
      match_researchers: [{ id: 'r-1', name: 'Lab' }],
    });
    expect(f.match_researchers).toEqual([{ id: 'r-1', name: 'Lab' }]);
    // Siblings of the overridden field remain at their defaults.
    expect(f.ignore_researchers).toEqual([]);
    expect(f.match_keywords).toEqual([]);
  });
});

describe('fuzz: ignore/match interactions with realistic study shapes', () => {
  it('an empty study (no researcher id, no keywords) falls through to numerics cleanly', () => {
    const study = {
      id: 's1', name: '', description: '', study_labels: [], ai_inferred_study_labels: [],
      researcher: { id: '', name: '', country: '' },
      reward: { amount: 1000, currency: 'GBP' },
      average_reward_per_hour: { amount: 1000, currency: 'GBP' },
      estimated_completion_time: 10, places_available: 10, total_available_places: 10, places_taken: 0,
    } as unknown as Study;
    const openFilter = createDefaultPriorityFilter();
    expect(studyMatchesPriorityFilter(study, openFilter)).toBe(true);
  });

  it('extreme string inputs do not throw (unicode, emoji, RTL, HTML)', () => {
    const id = 'r-‏x🎉<script>';
    const study = {
      id: 's1', name: '<b>bold</b>', description: 'يمين إلى يسار',
      study_labels: ['🎉🎉🎉'], ai_inferred_study_labels: [],
      researcher: { id, name: '&lt;n&gt;', country: 'XX' },
      reward: { amount: 100, currency: 'GBP' },
      average_reward_per_hour: { amount: 100, currency: 'GBP' },
      estimated_completion_time: 10, places_available: 1, total_available_places: 1, places_taken: 0,
    } as unknown as Study;
    const filter = createDefaultPriorityFilter({
      match_researchers: [{ id, name: 'anything' }],
      ignore_keywords: ['🎉🎉🎉'],
    });
    // Ignore keyword fires before match researcher — still boolean, no throw.
    expect(() => studyMatchesPriorityFilter(study, filter)).not.toThrow();
    expect(typeof studyMatchesPriorityFilter(study, filter)).toBe('boolean');
  });
});
