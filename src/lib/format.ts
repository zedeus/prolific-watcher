import type { Money, NormalizedRefreshPolicy } from './types';
import type { SoundType } from './constants';
import {
  PRIORITY_ALERT_SOUND_TYPES,
  DEFAULT_PRIORITY_ALERT_SOUND_TYPE,
  STUDIES_REFRESH_CYCLE_SECONDS,
  DEFAULT_STUDIES_REFRESH_MIN_DELAY_SECONDS,
  DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
  DEFAULT_STUDIES_REFRESH_SPREAD_SECONDS,
  MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS,
  MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
  MAX_STUDIES_REFRESH_MIN_DELAY_SECONDS,
  MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
  MAX_STUDIES_REFRESH_SPREAD_SECONDS,
} from './constants';

const shortNumberFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const currencyFmtCache = new Map<string, Intl.NumberFormat>();
const currencySymbolCache = new Map<string, string>();
const clockTimeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function getCurrencyFmt(code: string): Intl.NumberFormat {
  let fmt = currencyFmtCache.get(code);
  if (!fmt) {
    fmt = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    currencyFmtCache.set(code, fmt);
  }
  return fmt;
}

export function getCurrencySymbol(currency: string): string {
  const code = (currency || 'USD').toUpperCase();
  let symbol = currencySymbolCache.get(code);
  if (symbol === undefined) {
    try {
      const formatted = new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(0);
      symbol = formatted.replace(/[\d.,\s]/g, '').trim() || code;
    } catch {
      symbol = code;
    }
    currencySymbolCache.set(code, symbol);
  }
  return symbol;
}

export function formatShortNumber(value: number): string {
  if (!Number.isFinite(value)) return '';
  return shortNumberFmt.format(value);
}

/** Comparator for `.sort()`: larger finite numbers first, non-finite (NaN/Infinity) last, else 0. */
export function compareNumberDesc(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return b - a;
  if (af !== bf) return af ? -1 : 1;
  return 0;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = parseInt(String(value), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = parseFloat(String(value));
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function moneyMajorValue(money: Money | null | undefined): number {
  if (!money) return NaN;
  const rawAmount = Number(money.amount);
  if (!Number.isFinite(rawAmount)) return NaN;
  return rawAmount / 100;
}

export function formatMoneyFromMajorUnits(amountMajor: number, currency: string): string {
  const major = Number(amountMajor);
  const code = String(currency || '').toUpperCase();
  if (!Number.isFinite(major) || !code) return 'n/a';
  try {
    return getCurrencyFmt(code).format(major);
  } catch {
    return `${major.toFixed(2)} ${code}`;
  }
}

export function formatMoneyFromMinorUnits(money: Money | null | undefined): string {
  if (!money) return 'n/a';
  return formatMoneyFromMajorUnits(moneyMajorValue(money), money.currency);
}

export function formatDurationMinutes(value: unknown): string {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 'n/a';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) return `${hours}h`;
  return `${hours}h ${remaining}m`;
}

export function formatDurationSeconds(value: unknown): string {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 'n/a';
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes < 60) {
    if (remainingSeconds === 0) return `${minutes}m`;
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}h`;
  return `${hours}h ${remainingMinutes}m`;
}

export function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatRelative(value: unknown, includeClock = false): string {
  const date = parseDate(value);
  if (!date) return 'never';
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const absDiffMs = Math.abs(diffMs);

  let text: string;
  if (absDiffMs < 60_000) {
    text = RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / 1000), 'second');
  } else if (absDiffMs < 3_600_000) {
    text = RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / 60_000), 'minute');
  } else if (absDiffMs < 86_400_000) {
    text = RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / 3_600_000), 'hour');
  } else {
    text = RELATIVE_TIME_FORMATTER.format(Math.round(diffMs / 86_400_000), 'day');
  }

  if (includeClock) {
    const clockTime = clockTimeFmt.format(date);
    text += ` · ${clockTime}`;
  }
  return text;
}

/**
 * Coerce any unknown value to a trimmed string, returning '' for non-strings.
 * Common guard for data coming off the network / storage / postMessage.
 */
export function trimString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error) return trimString(error.message);
  if (typeof error === 'string') return error.trim();
  if (error == null) return '';
  return String(error);
}

export function toUserErrorMessage(error: unknown): string {
  const msg = errorMessageFromUnknown(error);
  return String(msg || '').trim() || 'Unexpected error.';
}

export function normalizeSubmissionStatus(status: string): string {
  return String(status || '')
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function formatSubmissionStatus(status: string): string {
  const normalized = normalizeSubmissionStatus(status);
  if (!normalized) return 'Unknown';
  return normalized
    .split(' ')
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}

function perHourBadgeVariant(value: number): 'ultra' | 'high' | null {
  const hourly = Number(value);
  if (!Number.isFinite(hourly)) return null;
  if (hourly > 15) return 'ultra';
  if (hourly > 10) return 'high';
  return null;
}

export function rateColorClass(value: number): string {
  const variant = perHourBadgeVariant(value);
  if (variant === 'ultra') return 'text-violet-600 dark:text-violet-400';
  if (variant === 'high') return 'text-emerald-600 dark:text-emerald-400';
  return 'text-base-content/45';
}

export function canonicalSoundType(value: unknown): SoundType {
  const raw = String(value || '').trim();
  if (PRIORITY_ALERT_SOUND_TYPES.has(raw as SoundType)) return raw as SoundType;
  return DEFAULT_PRIORITY_ALERT_SOUND_TYPE;
}

export function compactText(value: string, maxLength = 72): string {
  if (!value || value.length <= maxLength) return value || '';
  return value.slice(0, maxLength - 1) + '…';
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function studyUrlFromId(studyID: string): string {
  return `https://app.prolific.com/studies/${encodeURIComponent(studyID)}`;
}

function calculatedCycleSecondsFromAverage(averageDelaySeconds: number): number {
  const average = clampInt(averageDelaySeconds, MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS, MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS, DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS);
  const countByAverage = Math.max(0, Math.floor(STUDIES_REFRESH_CYCLE_SECONDS / average) - 1);
  const segments = countByAverage + 1;
  return Math.max(1, Math.floor(STUDIES_REFRESH_CYCLE_SECONDS / segments));
}

export function normalizeRefreshPolicy(minDelay: number, avgDelay: number, spread: number): NormalizedRefreshPolicy {
  const average = clampInt(avgDelay, MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS, MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS, DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS);
  const calculatedCycleSeconds = calculatedCycleSecondsFromAverage(average);
  const maximumMinimumDelaySeconds = Math.max(
    MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS,
    Math.min(MAX_STUDIES_REFRESH_MIN_DELAY_SECONDS, Math.floor(calculatedCycleSeconds / 2)),
  );
  const maximumSpreadSeconds = Math.max(
    0,
    Math.min(MAX_STUDIES_REFRESH_SPREAD_SECONDS, Math.floor(calculatedCycleSeconds / 2)),
  );
  const minimum = clampInt(minDelay, MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS, maximumMinimumDelaySeconds, DEFAULT_STUDIES_REFRESH_MIN_DELAY_SECONDS);
  const spreadClamped = clampInt(spread, 0, maximumSpreadSeconds, DEFAULT_STUDIES_REFRESH_SPREAD_SECONDS);

  return {
    minimum_delay_seconds: minimum,
    average_delay_seconds: average,
    spread_seconds: spreadClamped,
    cycle_seconds: STUDIES_REFRESH_CYCLE_SECONDS,
    maximum_minimum_delay_seconds: maximumMinimumDelaySeconds,
    maximum_spread_seconds: maximumSpreadSeconds,
  };
}

export function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STUDY_LABEL_DISPLAY: Record<string, string> = {
  'ai_evaluation': 'AI Training',
  'ai_training': 'AI Training',
  'survey': 'Survey',
  'interview': 'Interview',
  'experiment': 'Experiment',
  'longitudinal': 'Longitudinal',
  'decision_making_task': 'Decision Making',
  'data_collection': 'Data Collection',
};

export function formatStudyLabel(studyLabels: string[], aiLabels: string[] = []): string {
  const raw = ((studyLabels[0] || aiLabels[0]) ?? '').trim();
  if (!raw) return '';
  const mapped = STUDY_LABEL_DISPLAY[raw];
  if (mapped) return mapped;
  // Strip trailing _task, convert underscores to spaces, title-case
  return raw
    .replace(/_task$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function stripHTML(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cloneTelegramSettings<T extends { message_format: Record<string, unknown> }>(settings: T): T {
  return { ...settings, message_format: { ...settings.message_format } };
}

export function isAuthRequiredState(state: { token_auth_required?: boolean; token_ok?: boolean; token_reason?: string } | null): boolean {
  if (!state) return false;
  if (state.token_auth_required === true) return true;
  if (state.token_ok !== false) return false;
  const reason = String(state.token_reason || '').toLowerCase();
  return (
    reason.includes('no valid oidc.user token payload') ||
    reason.includes('signed out of prolific')
  );
}

export interface SyncStatusFields {
  token_ok?: boolean;
  token_reason?: string;
  studies_refresh_ok?: boolean;
  studies_refresh_reason?: string;
  studies_response_capture_supported?: boolean;
  studies_response_capture_ok?: boolean;
  studies_response_capture_reason?: string;
}

/**
 * Derive the single human-readable status line the popup shows, in priority order: a token problem
 * first (auth is the root cause of most stalls), then a failed studies refresh — this is where the
 * issue-#25 recovery states surface (session-expired/reconnecting and the persistent "not updating"
 * line arrive pre-worded in studies_refresh_reason) — then a response-capture problem. An empty
 * string means healthy. Kept pure so the state→message contract is unit-testable without a browser.
 */
export function isTransientStatusMessage(message: string): boolean {
  return message.includes('reconnecting') ||
    message.includes('Rate limited') ||
    message.includes('Resuming in');
}

export function deriveSyncStatusMessage(state: SyncStatusFields | null): string {
  if (!state) return '';
  if (state.token_ok === false) return String(state.token_reason || 'Token sync error.').trim();
  if (state.studies_refresh_ok === false) {
    return String(state.studies_refresh_reason || 'Studies refresh sync error.').trim();
  }
  if (
    state.studies_response_capture_supported === true &&
    state.studies_response_capture_ok === false &&
    state.studies_response_capture_reason
  ) {
    return String(state.studies_response_capture_reason).trim();
  }
  return '';
}
