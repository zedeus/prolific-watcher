import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPrioritySettings } from '../../entrypoints/background/settings';
import type { PriorityFilter } from '../types';
import type { SoundType } from '../constants';
import {
  PRIORITY_FILTERS_KEY,
  LEGACY_PRIORITY_FILTER_ENABLED_KEY,
  LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY,
  LEGACY_PRIORITY_FILTER_MIN_HOURLY_REWARD_KEY,
  LEGACY_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES_KEY,
  LEGACY_PRIORITY_FILTER_MIN_PLACES_KEY,
  LEGACY_PRIORITY_FILTER_ALERT_SOUND_TYPE_KEY,
  LEGACY_PRIORITY_FILTER_ALERT_SOUND_VOLUME_KEY,
  LEGACY_PRIORITY_FILTER_ALWAYS_OPEN_KEYWORDS_KEY,
} from '../constants';

// ── Mock browser.storage.local ───────────────────────────────────

const storage = new Map<string, unknown>();

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const k of keyList) {
            if (storage.has(k)) result[k] = storage.get(k);
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) storage.set(k, v);
        }),
        remove: vi.fn(async (keys: string[]) => {
          for (const k of keys) storage.delete(k);
        }),
      },
    },
  },
}));

// ── Test setup ───────────────────────────────────────────────────

const TEST_LIMITS = {
  maxKeywords: 20,
  minMinReward: 0,
  maxMinReward: 100,
  minMinHourlyReward: 0,
  maxMinHourlyReward: 100,
  minEstimatedMinutes: 1,
  maxEstimatedMinutes: 240,
  minMinimumPlaces: 1,
  maxMinimumPlaces: 1000,
  minAlertSoundVolume: 0,
  maxAlertSoundVolume: 100,
};

const TEST_DEFAULTS = {
  minimumRewardMajor: 0,
  minimumHourlyRewardMajor: 10,
  maximumEstimatedMinutes: 20,
  minimumPlacesAvailable: 1,
  alertSoundType: 'pay' as SoundType,
  alertSoundVolume: 100,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
};

function createTestSettings() {
  return createPrioritySettings({ limits: TEST_LIMITS, defaults: TEST_DEFAULTS });
}

beforeEach(() => {
  storage.clear();
});

// ── normalizePriorityFilter ──────────────────────────────────────

describe('normalizePriorityFilter', () => {
  it('generates id and name for empty input', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({});
    expect(filter.id).toBeTruthy();
    expect(filter.name).toBe('Filter');
    expect(filter.enabled).toBe(false);
  });

  it('preserves valid id and name', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({ id: 'abc-123', name: 'High Pay' });
    expect(filter.id).toBe('abc-123');
    expect(filter.name).toBe('High Pay');
  });

  it('clamps reward to limits', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ minimum_reward_major: -5 }).minimum_reward_major).toBe(0);
    expect(normalizePriorityFilter({ minimum_reward_major: 999 }).minimum_reward_major).toBe(100);
    expect(normalizePriorityFilter({ minimum_reward_major: 5.555 }).minimum_reward_major).toBe(5.56);
  });

  it('clamps hourly reward to limits', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ minimum_hourly_reward_major: -1 }).minimum_hourly_reward_major).toBe(0);
    expect(normalizePriorityFilter({ minimum_hourly_reward_major: 200 }).minimum_hourly_reward_major).toBe(100);
  });

  it('clamps estimated minutes to limits', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ maximum_estimated_minutes: 0 }).maximum_estimated_minutes).toBe(1);
    expect(normalizePriorityFilter({ maximum_estimated_minutes: 500 }).maximum_estimated_minutes).toBe(240);
  });

  it('clamps places to limits', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ minimum_places_available: 0 }).minimum_places_available).toBe(1);
    expect(normalizePriorityFilter({ minimum_places_available: 9999 }).minimum_places_available).toBe(1000);
  });

  it('clamps volume to limits', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ alert_sound_volume: -10 }).alert_sound_volume).toBe(0);
    expect(normalizePriorityFilter({ alert_sound_volume: 200 }).alert_sound_volume).toBe(100);
  });

  it('falls back to default sound type for invalid values', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ alert_sound_type: 'invalid' }).alert_sound_type).toBe('pay');
    expect(normalizePriorityFilter({ alert_sound_type: '' }).alert_sound_type).toBe('pay');
    expect(normalizePriorityFilter({ alert_sound_type: null }).alert_sound_type).toBe('pay');
  });

  it('accepts valid sound types', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ alert_sound_type: 'chime' }).alert_sound_type).toBe('chime');
    expect(normalizePriorityFilter({ alert_sound_type: 'metal_gear' }).alert_sound_type).toBe('metal_gear');
  });

  it('normalizes keywords: dedupes, lowercases, trims, caps at limit', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({
      match_keywords: ['AI', ' ai ', 'Survey', 'SURVEY', 'mobile'],
    });
    expect(filter.match_keywords).toEqual(['ai', 'survey', 'mobile']);
  });

  it('parses comma-separated keyword strings', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({
      match_keywords: 'ai, survey, mobile',
    });
    expect(filter.match_keywords).toEqual(['ai', 'survey', 'mobile']);
  });

  it('migrates legacy always_open_keywords field name', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({
      always_open_keywords: ['ai', 'survey'],
    });
    expect(filter.match_keywords).toEqual(['ai', 'survey']);
  });

  it('migrates legacy always_open_researchers field name', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({
      always_open_researchers: [{ id: 'r-1', name: 'Lab' }],
    });
    expect(filter.match_researchers).toEqual([{ id: 'r-1', name: 'Lab' }]);
  });

  it('uses defaults for NaN/undefined numeric fields', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({
      minimum_reward_major: 'not-a-number',
      minimum_hourly_reward_major: undefined,
      maximum_estimated_minutes: null,
      minimum_places_available: NaN,
    });
    expect(filter.minimum_reward_major).toBe(TEST_DEFAULTS.minimumRewardMajor);
    expect(filter.minimum_hourly_reward_major).toBe(TEST_DEFAULTS.minimumHourlyRewardMajor);
    expect(filter.maximum_estimated_minutes).toBe(TEST_DEFAULTS.maximumEstimatedMinutes);
    expect(filter.minimum_places_available).toBe(TEST_DEFAULTS.minimumPlacesAvailable);
  });

  it('enabled defaults to false, auto_open defaults to true', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({});
    expect(filter.enabled).toBe(false);
    expect(filter.auto_open_in_new_tab).toBe(true);
    expect(filter.alert_sound_enabled).toBe(true);
  });

  it('handles null/undefined input gracefully', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(() => normalizePriorityFilter(null)).not.toThrow();
    expect(() => normalizePriorityFilter(undefined)).not.toThrow();
    expect(() => normalizePriorityFilter(42)).not.toThrow();
  });

  it('defaults desktop_notify to false when missing', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({ id: 'x', name: 'X', enabled: true });
    expect(filter.desktop_notify).toBe(false);
  });

  it('preserves desktop_notify when true', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({ desktop_notify: true });
    expect(filter.desktop_notify).toBe(true);
  });

  it('defaults quiet_hours_enabled to false when missing', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({});
    expect(filter.quiet_hours_enabled).toBe(false);
  });

  it('preserves quiet_hours_enabled when true', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({ quiet_hours_enabled: true });
    expect(filter.quiet_hours_enabled).toBe(true);
  });

  it('defaults quiet hours times when missing', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({});
    expect(filter.quiet_hours_start).toBe('23:00');
    expect(filter.quiet_hours_end).toBe('07:00');
  });

  it('preserves valid quiet hours times', () => {
    const { normalizePriorityFilter } = createTestSettings();
    const filter = normalizePriorityFilter({ quiet_hours_start: '01:30', quiet_hours_end: '05:45' });
    expect(filter.quiet_hours_start).toBe('01:30');
    expect(filter.quiet_hours_end).toBe('05:45');
  });

  it('falls back to defaults for malformed quiet hours times', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ quiet_hours_start: 'nope' }).quiet_hours_start).toBe('23:00');
    expect(normalizePriorityFilter({ quiet_hours_end: '' }).quiet_hours_end).toBe('07:00');
    expect(normalizePriorityFilter({ quiet_hours_start: 123 as any }).quiet_hours_start).toBe('23:00');
    expect(normalizePriorityFilter({ quiet_hours_end: null as any }).quiet_hours_end).toBe('07:00');
  });

  it('rejects out-of-range quiet hours values', () => {
    const { normalizePriorityFilter } = createTestSettings();
    expect(normalizePriorityFilter({ quiet_hours_start: '25:00' }).quiet_hours_start).toBe('23:00');
    expect(normalizePriorityFilter({ quiet_hours_end: '12:60' }).quiet_hours_end).toBe('07:00');
    expect(normalizePriorityFilter({ quiet_hours_start: '99:99' }).quiet_hours_start).toBe('23:00');
  });
});

// ── normalizePriorityFilters ─────────────────────────────────────

describe('normalizePriorityFilters', () => {
  it('returns empty array for non-array input', () => {
    const { normalizePriorityFilters } = createTestSettings();
    expect(normalizePriorityFilters(null)).toEqual([]);
    expect(normalizePriorityFilters(undefined)).toEqual([]);
    expect(normalizePriorityFilters('string')).toEqual([]);
    expect(normalizePriorityFilters(42)).toEqual([]);
    expect(normalizePriorityFilters({})).toEqual([]);
  });

  it('normalizes each filter in the array', () => {
    const { normalizePriorityFilters } = createTestSettings();
    const filters = normalizePriorityFilters([
      { id: 'a', name: 'A', enabled: true, minimum_reward_major: 5 },
      { id: 'b', name: 'B', enabled: false, minimum_reward_major: 10 },
    ]);
    expect(filters).toHaveLength(2);
    expect(filters[0].id).toBe('a');
    expect(filters[0].minimum_reward_major).toBe(5);
    expect(filters[1].minimum_reward_major).toBe(10);
  });

  it('caps array at MAX_PRIORITY_FILTERS', () => {
    const { normalizePriorityFilters } = createTestSettings();
    const input = Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    const filters = normalizePriorityFilters(input);
    expect(filters.length).toBe(10); // MAX_PRIORITY_FILTERS
  });
});

// ── getPriorityFilters ───────────────────────────────────────────

describe('getPriorityFilters', () => {
  it('returns empty array when storage is empty', async () => {
    const { getPriorityFilters } = createTestSettings();
    const filters = await getPriorityFilters();
    expect(filters).toEqual([]);
  });

  it('returns normalized filters from storage', async () => {
    storage.set(PRIORITY_FILTERS_KEY, [
      { id: 'x', name: 'X', enabled: true, minimum_reward_major: 5 },
    ]);
    const { getPriorityFilters } = createTestSettings();
    const filters = await getPriorityFilters();
    expect(filters).toHaveLength(1);
    expect(filters[0].id).toBe('x');
    expect(filters[0].minimum_reward_major).toBe(5);
  });
});

// ── migrateLegacyPriorityFilter ──────────────────────────────────

describe('migrateLegacyPriorityFilter', () => {
  it('skips migration when priorityFilters already exists', async () => {
    storage.set(PRIORITY_FILTERS_KEY, [{ id: 'existing', name: 'Existing' }]);
    storage.set(LEGACY_PRIORITY_FILTER_ENABLED_KEY, true);

    const { migrateLegacyPriorityFilter } = createTestSettings();
    await migrateLegacyPriorityFilter();

    // Original should be untouched
    const filters = storage.get(PRIORITY_FILTERS_KEY) as PriorityFilter[];
    expect(filters).toHaveLength(1);
    expect((filters[0] as any).id).toBe('existing');
  });

  it('skips migration on fresh install (no legacy keys)', async () => {
    const { migrateLegacyPriorityFilter } = createTestSettings();
    await migrateLegacyPriorityFilter();

    expect(storage.has(PRIORITY_FILTERS_KEY)).toBe(false);
  });

  it('migrates legacy keys to single filter array', async () => {
    storage.set(LEGACY_PRIORITY_FILTER_ENABLED_KEY, true);
    storage.set(LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY, 3);
    storage.set(LEGACY_PRIORITY_FILTER_MIN_HOURLY_REWARD_KEY, 8);
    storage.set(LEGACY_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES_KEY, 15);
    storage.set(LEGACY_PRIORITY_FILTER_MIN_PLACES_KEY, 2);
    storage.set(LEGACY_PRIORITY_FILTER_ALERT_SOUND_TYPE_KEY, 'chime');
    storage.set(LEGACY_PRIORITY_FILTER_ALERT_SOUND_VOLUME_KEY, 75);
    storage.set(LEGACY_PRIORITY_FILTER_ALWAYS_OPEN_KEYWORDS_KEY, ['ai', 'survey']);

    const { migrateLegacyPriorityFilter } = createTestSettings();
    await migrateLegacyPriorityFilter();

    const filters = storage.get(PRIORITY_FILTERS_KEY) as PriorityFilter[];
    expect(filters).toHaveLength(1);
    expect(filters[0].name).toBe('Filter 1');
    expect(filters[0].enabled).toBe(true);
    expect(filters[0].minimum_reward_major).toBe(3);
    expect(filters[0].minimum_hourly_reward_major).toBe(8);
    expect(filters[0].maximum_estimated_minutes).toBe(15);
    expect(filters[0].minimum_places_available).toBe(2);
    expect(filters[0].alert_sound_type).toBe('chime');
    expect(filters[0].alert_sound_volume).toBe(75);
    expect(filters[0].match_keywords).toEqual(['ai', 'survey']);
  });

  it('removes legacy keys after migration', async () => {
    storage.set(LEGACY_PRIORITY_FILTER_ENABLED_KEY, true);
    storage.set(LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY, 5);

    const { migrateLegacyPriorityFilter } = createTestSettings();
    await migrateLegacyPriorityFilter();

    expect(storage.has(LEGACY_PRIORITY_FILTER_ENABLED_KEY)).toBe(false);
    expect(storage.has(LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY)).toBe(false);
  });

  it('handles partial legacy data gracefully', async () => {
    // Only enabled key set, all others missing
    storage.set(LEGACY_PRIORITY_FILTER_ENABLED_KEY, false);

    const { migrateLegacyPriorityFilter } = createTestSettings();
    await migrateLegacyPriorityFilter();

    const filters = storage.get(PRIORITY_FILTERS_KEY) as PriorityFilter[];
    expect(filters).toHaveLength(1);
    expect(filters[0].enabled).toBe(false);
    // Should use defaults for missing fields
    expect(filters[0].minimum_hourly_reward_major).toBe(TEST_DEFAULTS.minimumHourlyRewardMajor);
    expect(filters[0].maximum_estimated_minutes).toBe(TEST_DEFAULTS.maximumEstimatedMinutes);
    expect(filters[0].alert_sound_type).toBe(TEST_DEFAULTS.alertSoundType);
  });
});
