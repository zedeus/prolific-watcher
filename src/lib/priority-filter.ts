import type { PriorityFilter } from './types';
import {
  DEFAULT_PRIORITY_ALERT_SOUND_TYPE,
  DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
  DEFAULT_QUIET_HOURS_START,
  DEFAULT_QUIET_HOURS_END,
  MIN_PRIORITY_FILTER_MIN_REWARD,
  MIN_PRIORITY_FILTER_MIN_HOURLY_REWARD,
  MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
  DEFAULT_PRIORITY_FILTER_MIN_ESTIMATED_MINUTES,
  MIN_PRIORITY_FILTER_MIN_PLACES,
} from './constants';

export function createDefaultPriorityFilter(overrides: Partial<PriorityFilter> = {}): PriorityFilter {
  return {
    id: crypto.randomUUID(),
    name: 'Filter',
    enabled: true,
    auto_open_in_new_tab: true,
    alert_sound_enabled: true,
    alert_sound_type: DEFAULT_PRIORITY_ALERT_SOUND_TYPE,
    alert_sound_volume: DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
    telegram_notify: true,
    desktop_notify: false,
    quiet_hours_enabled: false,
    quiet_hours_start: DEFAULT_QUIET_HOURS_START,
    quiet_hours_end: DEFAULT_QUIET_HOURS_END,
    minimum_reward_major: MIN_PRIORITY_FILTER_MIN_REWARD,
    minimum_hourly_reward_major: MIN_PRIORITY_FILTER_MIN_HOURLY_REWARD,
    maximum_estimated_minutes: MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
    minimum_estimated_minutes: DEFAULT_PRIORITY_FILTER_MIN_ESTIMATED_MINUTES,
    minimum_places_available: MIN_PRIORITY_FILTER_MIN_PLACES,
    allowed_study_types: [],
    match_keywords: [],
    ignore_keywords: [],
    match_researchers: [],
    ignore_researchers: [],
    match_study_ids: [],
    ignore_study_ids: [],
    dry_run: false,
    ...overrides,
  };
}

function parseHHMM(time: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

export function isInQuietHours(filter: PriorityFilter, now?: Date): boolean {
  if (!filter.quiet_hours_enabled) return false;
  const start = parseHHMM(filter.quiet_hours_start);
  const end = parseHHMM(filter.quiet_hours_end);
  if (!start || !end) return false;

  const d = now ?? new Date();
  const currentMinutes = d.getHours() * 60 + d.getMinutes();
  const startMinutes = start.hours * 60 + start.minutes;
  const endMinutes = end.hours * 60 + end.minutes;

  if (startMinutes === endMinutes) return false;

  if (startMinutes < endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight span (e.g. 23:00–07:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}
