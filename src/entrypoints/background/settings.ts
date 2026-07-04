import { browser } from 'wxt/browser';
import type { PriorityFilter, ResearcherRef } from '../../lib/types';
import type { SoundType } from '../../lib/constants';
import { clampNumber, clampInt } from '../../lib/format';
import {
  PRIORITY_ALERT_SOUND_TYPES,
  PRIORITY_FILTERS_KEY,
  MAX_PRIORITY_FILTERS,
  MAX_PRIORITY_FILTER_RESEARCHERS,
  MAX_PRIORITY_FILTER_STUDY_IDS,
  ALL_STUDY_TYPES,
  LEGACY_PRIORITY_FILTER_ENABLED_KEY,
  LEGACY_PRIORITY_FILTER_AUTO_OPEN_NEW_TAB_KEY,
  LEGACY_PRIORITY_FILTER_ALERT_SOUND_ENABLED_KEY,
  LEGACY_PRIORITY_FILTER_ALERT_SOUND_TYPE_KEY,
  LEGACY_PRIORITY_FILTER_ALERT_SOUND_VOLUME_KEY,
  LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY,
  LEGACY_PRIORITY_FILTER_MIN_HOURLY_REWARD_KEY,
  LEGACY_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES_KEY,
  LEGACY_PRIORITY_FILTER_MIN_PLACES_KEY,
  LEGACY_PRIORITY_FILTER_ALWAYS_OPEN_KEYWORDS_KEY,
  LEGACY_PRIORITY_FILTER_IGNORE_KEYWORDS_KEY,
} from '../../lib/constants';

export interface PrioritySettingsLimits {
  maxKeywords: number;
  maxMinReward: number;
  minMinReward: number;
  maxMinHourlyReward: number;
  minMinHourlyReward: number;
  maxEstimatedMinutes: number;
  minEstimatedMinutes: number;
  maxMinEstimatedMinutes: number;
  minMinEstimatedMinutes: number;
  maxMinimumPlaces: number;
  minMinimumPlaces: number;
  maxAlertSoundVolume: number;
  minAlertSoundVolume: number;
  maxStudyIDs: number;
}

export interface PrioritySettingsDefaults {
  minimumRewardMajor: number;
  minimumHourlyRewardMajor: number;
  maximumEstimatedMinutes: number;
  minimumEstimatedMinutes: number;
  minimumPlacesAvailable: number;
  alertSoundType: SoundType;
  alertSoundVolume: number;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export interface CreatePrioritySettingsOptions {
  limits: PrioritySettingsLimits;
  defaults: PrioritySettingsDefaults;
}

export interface PrioritySettings {
  normalizePriorityFilter: (raw: unknown) => PriorityFilter;
  normalizePriorityFilters: (raw: unknown) => PriorityFilter[];
  getPriorityFilters: () => Promise<PriorityFilter[]>;
  migrateLegacyPriorityFilter: () => Promise<void>;
}

export function createPrioritySettings(options: CreatePrioritySettingsOptions): PrioritySettings {
  const {
    limits,
    defaults,
  } = options;

  function normalizePriorityKeywordList(rawKeywords: unknown): string[] {
    const values = Array.isArray(rawKeywords)
      ? rawKeywords
      : String(rawKeywords || '').split(',');

    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of values) {
      const keyword = String(value || '').trim().toLowerCase();
      if (!keyword || seen.has(keyword)) {
        continue;
      }
      seen.add(keyword);
      normalized.push(keyword);
      if (normalized.length >= limits.maxKeywords) {
        break;
      }
    }
    return normalized;
  }

  function normalizePriorityResearcherList(raw: unknown): ResearcherRef[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: ResearcherRef[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const id = String(r.id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = String(r.name ?? '').trim();
      out.push({ id, name });
      if (out.length >= MAX_PRIORITY_FILTER_RESEARCHERS) break;
    }
    return out;
  }

  function normalizePriorityStudyIDList(raw: unknown): string[] {
    const values = Array.isArray(raw)
      ? raw
      : String(raw || '').split(',');
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const value of values) {
      const id = String(value || '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
      if (normalized.length >= limits.maxStudyIDs) break;
    }
    return normalized;
  }

  function normalizeAllowedStudyTypes(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const validSet = new Set(ALL_STUDY_TYPES as readonly string[]);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const v of raw) {
      const t = String(v || '').trim().toLowerCase();
      if (!t || !validSet.has(t) || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
    return out;
  }

  function canonicalPriorityAlertSoundType(value: unknown): SoundType {
    const raw = String(value || '').trim();
    if (PRIORITY_ALERT_SOUND_TYPES.has(raw as SoundType)) {
      return raw as SoundType;
    }
    return defaults.alertSoundType;
  }

  function normalizePriorityFilter(raw: unknown): PriorityFilter {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

    const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : crypto.randomUUID();
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Filter';

    const minimumRewardMajor = clampNumber(r.minimum_reward_major, limits.minMinReward, limits.maxMinReward, defaults.minimumRewardMajor);
    const minimumHourlyRewardMajor = clampNumber(r.minimum_hourly_reward_major, limits.minMinHourlyReward, limits.maxMinHourlyReward, defaults.minimumHourlyRewardMajor);
    const maximumEstimatedMinutes = clampInt(r.maximum_estimated_minutes, limits.minEstimatedMinutes, limits.maxEstimatedMinutes, defaults.maximumEstimatedMinutes);
    const minimumEstimatedMinutes = clampInt(r.minimum_estimated_minutes, limits.minMinEstimatedMinutes, limits.maxMinEstimatedMinutes, defaults.minimumEstimatedMinutes);
    const minimumPlacesAvailable = clampInt(r.minimum_places_available, limits.minMinimumPlaces, limits.maxMinimumPlaces, defaults.minimumPlacesAvailable);
    const normalizedAlertSoundType = canonicalPriorityAlertSoundType(r.alert_sound_type);
    const alertSoundVolume = clampInt(r.alert_sound_volume, limits.minAlertSoundVolume, limits.maxAlertSoundVolume, defaults.alertSoundVolume);

    const validTimeRe = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
    const quietHoursStart = typeof r.quiet_hours_start === 'string' && validTimeRe.test(r.quiet_hours_start)
      ? r.quiet_hours_start : defaults.quietHoursStart;
    const quietHoursEnd = typeof r.quiet_hours_end === 'string' && validTimeRe.test(r.quiet_hours_end)
      ? r.quiet_hours_end : defaults.quietHoursEnd;

    return {
      id,
      name,
      enabled: r.enabled === true,
      auto_open_in_new_tab: r.auto_open_in_new_tab !== false,
      alert_sound_enabled: r.alert_sound_enabled !== false,
      alert_sound_type: normalizedAlertSoundType,
      alert_sound_volume: alertSoundVolume,
      telegram_notify: r.telegram_notify !== false,
      desktop_notify: r.desktop_notify === true,
      quiet_hours_enabled: r.quiet_hours_enabled === true,
      quiet_hours_start: quietHoursStart,
      quiet_hours_end: quietHoursEnd,
      minimum_reward_major: Math.round(minimumRewardMajor * 100) / 100,
      minimum_hourly_reward_major: Math.round(minimumHourlyRewardMajor * 100) / 100,
      maximum_estimated_minutes: maximumEstimatedMinutes,
      minimum_estimated_minutes: minimumEstimatedMinutes,
      allowed_study_types: normalizeAllowedStudyTypes(r.allowed_study_types),
      minimum_places_available: minimumPlacesAvailable,
      match_keywords: normalizePriorityKeywordList(r.match_keywords ?? r.always_open_keywords),
      ignore_keywords: normalizePriorityKeywordList(r.ignore_keywords),
      match_researchers: normalizePriorityResearcherList(r.match_researchers ?? r.always_open_researchers),
      ignore_researchers: normalizePriorityResearcherList(r.ignore_researchers),
      match_study_ids: normalizePriorityStudyIDList(r.match_study_ids),
      ignore_study_ids: normalizePriorityStudyIDList(r.ignore_study_ids),
      dry_run: r.dry_run === true,
    };
  }

  function normalizePriorityFilters(raw: unknown): PriorityFilter[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.slice(0, MAX_PRIORITY_FILTERS).map((item) => normalizePriorityFilter(item));
  }

  async function getPriorityFilters(): Promise<PriorityFilter[]> {
    const data = await browser.storage.local.get(PRIORITY_FILTERS_KEY);
    return normalizePriorityFilters(data[PRIORITY_FILTERS_KEY]);
  }

  const LEGACY_KEYS = [
    LEGACY_PRIORITY_FILTER_ENABLED_KEY,
    LEGACY_PRIORITY_FILTER_AUTO_OPEN_NEW_TAB_KEY,
    LEGACY_PRIORITY_FILTER_ALERT_SOUND_ENABLED_KEY,
    LEGACY_PRIORITY_FILTER_ALERT_SOUND_TYPE_KEY,
    LEGACY_PRIORITY_FILTER_ALERT_SOUND_VOLUME_KEY,
    LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY,
    LEGACY_PRIORITY_FILTER_MIN_HOURLY_REWARD_KEY,
    LEGACY_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES_KEY,
    LEGACY_PRIORITY_FILTER_MIN_PLACES_KEY,
    LEGACY_PRIORITY_FILTER_ALWAYS_OPEN_KEYWORDS_KEY,
    LEGACY_PRIORITY_FILTER_IGNORE_KEYWORDS_KEY,
  ];

  async function migrateLegacyPriorityFilter(): Promise<void> {
    const data = await browser.storage.local.get([PRIORITY_FILTERS_KEY, ...LEGACY_KEYS]);

    if (data[PRIORITY_FILTERS_KEY] !== undefined) return;
    if (data[LEGACY_PRIORITY_FILTER_ENABLED_KEY] === undefined) return;

    const migratedFilter = normalizePriorityFilter({
      id: crypto.randomUUID(),
      name: 'Filter 1',
      enabled: data[LEGACY_PRIORITY_FILTER_ENABLED_KEY] === true,
      auto_open_in_new_tab: data[LEGACY_PRIORITY_FILTER_AUTO_OPEN_NEW_TAB_KEY],
      alert_sound_enabled: data[LEGACY_PRIORITY_FILTER_ALERT_SOUND_ENABLED_KEY],
      alert_sound_type: data[LEGACY_PRIORITY_FILTER_ALERT_SOUND_TYPE_KEY],
      alert_sound_volume: data[LEGACY_PRIORITY_FILTER_ALERT_SOUND_VOLUME_KEY],
      minimum_reward_major: data[LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY],
      minimum_hourly_reward_major: data[LEGACY_PRIORITY_FILTER_MIN_HOURLY_REWARD_KEY],
      maximum_estimated_minutes: data[LEGACY_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES_KEY],
      minimum_places_available: data[LEGACY_PRIORITY_FILTER_MIN_PLACES_KEY],
      always_open_keywords: data[LEGACY_PRIORITY_FILTER_ALWAYS_OPEN_KEYWORDS_KEY],
      ignore_keywords: data[LEGACY_PRIORITY_FILTER_IGNORE_KEYWORDS_KEY],
    });

    await browser.storage.local.set({ [PRIORITY_FILTERS_KEY]: [migratedFilter] });

    await browser.storage.local.remove(LEGACY_KEYS);
  }

  return Object.freeze({
    normalizePriorityFilter,
    normalizePriorityFilters,
    getPriorityFilters,
    migrateLegacyPriorityFilter,
  });
}
