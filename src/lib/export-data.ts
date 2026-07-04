import type { SubmissionRecord } from './db';
import type { DailyRollup, GroupAgg } from './earnings';
import { extractSubmissionReward, extractStartedAt, extractCompletedAt, mean } from './earnings';
import { researcherRefFromPayload, extractSubmissionMeta, extractRejectionDetails } from './submission-analytics';

// ──────────────────────────────────────────────────────────────
// CSV serialisation — inverse of import-csv's parseCsv.
// ──────────────────────────────────────────────────────────────

/** Quote a single CSV field if it contains a delimiter, quote, or newline. */
export function csvField(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serialise rows into RFC-4180-ish CSV text (CRLF line endings, Excel-friendly). */
export function toCsv(rows: (readonly unknown[])[]): string {
  return rows.map((row) => row.map(csvField).join(',')).join('\r\n');
}

// ──────────────────────────────────────────────────────────────
// Money / timestamp formatting — inverse of import-csv parsers, so
// exported submissions round-trip cleanly back through parseProlificCsv.
// ──────────────────────────────────────────────────────────────

/**
 * Currency → symbol for the unambiguous cases parseMoneyCell can read back to
 * the exact same code. Ambiguous symbols (kr → SEK/NOK/DKK) are intentionally
 * omitted so those fall through to the `amount CODE` form instead.
 */
const CURRENCY_TO_SYMBOL: Record<string, string> = {
  GBP: '£',
  EUR: '€',
  USD: '$',
  JPY: '¥',
  INR: '₹',
  RUB: '₽',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  HKD: 'HK$',
  SGD: 'S$',
  BRL: 'R$',
  PLN: 'zł',
};

/** Format a minor-unit amount + currency into a cell parseMoneyCell reads back losslessly. */
export function formatMoneyCell(amountMinor: number, currency: string): string {
  const major = (Math.round(amountMinor) / 100).toFixed(2);
  const code = String(currency || '').toUpperCase();
  const symbol = CURRENCY_TO_SYMBOL[code];
  if (symbol) return `${symbol}${major}`;
  // Unknown or ambiguous currency: trailing 3-letter code (also parseable).
  return code ? `${major} ${code}` : major;
}

/** `2026-03-25T16:10:53.160Z` → `2026-03-25 16:10:53.160000` (naive UTC, Prolific style). */
export function formatCsvTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const micros = `${pad(d.getUTCMilliseconds(), 3)}000`;
  return `${date} ${time}.${micros}`;
}

// ──────────────────────────────────────────────────────────────
// Submissions → CSV (mirrors the columns parseProlificCsv reads).
// ──────────────────────────────────────────────────────────────

export const SUBMISSIONS_CSV_HEADER = [
  // Prolific-format columns (round-trip through the stock importer).
  'Submission id',
  'Study',
  'Status',
  'Reward',
  'Bonus',
  'Started at',
  'Completed at',
  'Completion code',
  // Extension-only columns Prolific's own export lacks. The importer reads these
  // back when present, and ignores them on a stock Prolific CSV.
  'Researcher',
  'Researcher ID',
  'Researcher country',
  'Institution',
  'Trial',
  'Return reason',
  'Rejection category',
  'Rejection message',
  'Researcher feedback',
] as const;

const RETURNED_LIKE = new Set(['RETURNED', 'REJECTED']);

function payloadString(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Completion code, reading both payload shapes: live-API submissions carry it as
 * `study_code`, CSV-imported ones as `completion_code` (mirrors store.ts's
 * cross-source dedup key). Without this a real user's live submissions would
 * export a blank code and lose their identity on re-import.
 */
function extractCompletionCode(payload: Record<string, unknown>): string {
  const raw = payload.completion_code ?? payload.study_code;
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Total bonus across all payments, again spanning both shapes: live-API uses
 * `submission_bonuses`, CSV-imported uses `bonus_payments`. Prolific's own CSV
 * shows a single summed Bonus column, so we sum rather than take the first.
 */
function extractBonusTotal(payload: Record<string, unknown>): { amount: number; currency: string } | null {
  const list = Array.isArray(payload.bonus_payments)
    ? payload.bonus_payments
    : Array.isArray(payload.submission_bonuses)
      ? payload.submission_bonuses
      : [];
  let amount = 0;
  let currency = '';
  for (const b of list) {
    if (!b || typeof b !== 'object') continue;
    const amt = Number((b as { amount?: unknown }).amount);
    const cur = String((b as { currency?: unknown }).currency ?? '');
    if (Number.isFinite(amt) && amt > 0) {
      amount += amt;
      if (!currency) currency = cur;
    }
  }
  return amount > 0 && currency ? { amount, currency } : null;
}

/** Turn a stored submission into the [id, study, status, reward, bonus, started, completed, code] cells. */
export function submissionToRow(record: SubmissionRecord): string[] {
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const reward = extractSubmissionReward(record);
  const bonus = extractBonusTotal(payload);
  const researcher = researcherRefFromPayload(payload);
  const meta = extractSubmissionMeta(payload);
  const rejection = extractRejectionDetails(payload);

  const startedAt = extractStartedAt(record);
  // The importer stashes the completion time under returned_at for RETURNED/REJECTED,
  // so read it back from the same place to reconstruct the "Completed at" column.
  const completedIso = RETURNED_LIKE.has(record.status)
    ? payloadString(payload, 'returned_at') || payloadString(payload, 'completed_at')
    : payloadString(payload, 'completed_at');
  const completedAt = completedIso ? new Date(completedIso) : extractCompletedAt(record);

  return [
    record.submission_id,
    record.study_name ?? '',
    record.status ?? '',
    reward ? formatMoneyCell(reward.amount, reward.currency) : '',
    bonus ? formatMoneyCell(bonus.amount, bonus.currency) : '',
    startedAt ? formatCsvTimestamp(startedAt.toISOString()) : '',
    completedAt && !Number.isNaN(completedAt.getTime()) ? formatCsvTimestamp(completedAt.toISOString()) : '',
    extractCompletionCode(payload),
    // Extension-only fields (missing from Prolific's CSV), via the same
    // extractors the analytics use so both payload shapes are handled.
    researcher?.name ?? '',
    researcher?.id ?? '',
    researcher?.country ?? meta.researcher_country ?? '',
    meta.institution_name ?? '',
    meta.is_trial ? 'yes' : '',
    rejection.return_reason ?? '',
    rejection.rejection_category ?? '',
    rejection.rejection_message ?? '',
    rejection.researcher_message ?? '',
  ];
}

/** Serialise submissions to a Prolific-style CSV that round-trips through parseProlificCsv. */
export function submissionsToCsv(records: SubmissionRecord[]): string {
  const rows: (readonly unknown[])[] = [SUBMISSIONS_CSV_HEADER];
  for (const r of records) rows.push(submissionToRow(r));
  return toCsv(rows);
}

// ──────────────────────────────────────────────────────────────
// Analytics → CSV (computed rollups/summaries the caller passes in).
// ──────────────────────────────────────────────────────────────

const money2 = (minor: number) => (Math.round(minor) / 100).toFixed(2);
const round2 = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

export function dailyRollupsToCsv(rollups: DailyRollup[]): string {
  const rows: (readonly unknown[])[] = [
    ['Date', 'Currency', 'Submissions', 'Reward', 'Active hours', 'Focused hours', 'Reward/hr (active)', 'Reward/hr (focused)'],
  ];
  for (const r of rollups) {
    rows.push([
      r.date_key,
      r.currency,
      r.submission_count,
      money2(r.reward_minor),
      round2(r.active_span_seconds / 3600),
      round2(r.sum_duration_seconds / 3600),
      round2(r.hourly_active_major),
      round2(r.hourly_focused_major),
    ]);
  }
  return toCsv(rows);
}

/** Researcher/study summaries share the GroupAgg shape. `keyHeader` labels the first column. */
export function groupAggToCsv(rows: GroupAgg[], keyHeader: string): string {
  const out: (readonly unknown[])[] = [
    [keyHeader, 'Id', 'Currency', 'Submissions', 'Reward', 'Mean reward/hr'],
  ];
  for (const g of rows) {
    out.push([g.label, g.key, g.currency, g.submission_count, money2(g.reward_minor), round2(mean(g.hourly_rates))]);
  }
  return toCsv(out);
}

export interface ForecastRow {
  date_key: string;
  median: number;
  p25: number;
  p75: number;
}

export function forecastToCsv(points: ForecastRow[], currency: string): string {
  const rows: (readonly unknown[])[] = [['Date', 'Currency', 'Projected (median)', 'Low (p25)', 'High (p75)']];
  for (const p of points) rows.push([p.date_key, currency, round2(p.median), round2(p.p25), round2(p.p75)]);
  return toCsv(rows);
}

// Which analytics datasets can be exported. Drives the configurable UI.
export type AnalyticsDatasetKey = 'daily' | 'researchers' | 'studies' | 'forecast';

export interface AnalyticsBundle {
  currency: string;
  generated_at: string;
  daily?: DailyRollup[];
  researchers?: GroupAgg[];
  studies?: GroupAgg[];
  forecast?: ForecastRow[];
}

/** JSON form of the analytics export — includes only the sections present on the bundle. */
export function analyticsToJson(bundle: AnalyticsBundle): string {
  return JSON.stringify(bundle, dateReplacer, 2);
}

function dateReplacer(_key: string, value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value;
}

// ──────────────────────────────────────────────────────────────
// Full backup — all IndexedDB tables + extension settings.
// ──────────────────────────────────────────────────────────────

export const BACKUP_FORMAT = 'prolific-pulse-backup';

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  /** Dexie DB version the backup was taken at (for forward-compat awareness). */
  db_version: number;
  app_version: string;
  exported_at: string;
  /** IndexedDB store name → rows. */
  tables: Record<string, unknown[]>;
  /** browser.storage.local snapshot (settings, prefs). */
  settings: Record<string, unknown>;
}

export interface BackupParams {
  tables: Record<string, unknown[]>;
  settings: Record<string, unknown>;
  dbVersion: number;
  appVersion: string;
  exportedAt: string;
}

export function buildBackup(params: BackupParams): BackupFile {
  return {
    format: BACKUP_FORMAT,
    db_version: params.dbVersion,
    app_version: params.appVersion,
    exported_at: params.exportedAt,
    tables: params.tables,
    settings: params.settings,
  };
}

export interface BackupSummaryRow {
  name: string;
  count: number;
}

export interface BackupSummary {
  tables: BackupSummaryRow[];
  tableTotal: number;
  settingsCount: number;
  exportedAt: string;
}

/** Human-facing summary of what a backup contains (drives the restore-confirm UI). */
export function summarizeBackup(backup: BackupFile): BackupSummary {
  const tables = Object.entries(backup.tables ?? {})
    .map(([name, rows]) => ({ name, count: Array.isArray(rows) ? rows.length : 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    tables,
    tableTotal: tables.reduce((sum, t) => sum + t.count, 0),
    settingsCount: Object.keys(backup.settings ?? {}).length,
    exportedAt: backup.exported_at ?? '',
  };
}

export type BackupValidation =
  | { ok: true; backup: BackupFile }
  | { ok: false; error: string };

/** Parse + shape-check untrusted backup JSON. Never throws. */
export function validateBackup(raw: unknown): BackupValidation {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return { ok: false, error: "That file isn't valid JSON." };
    }
  }
  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: "That file doesn't look like a Prolific Pulse backup." };
  }
  const b = obj as Record<string, unknown>;
  if (b.format !== BACKUP_FORMAT) {
    return { ok: false, error: "That file isn't a Prolific Pulse backup (wrong format tag)." };
  }
  if (!b.tables || typeof b.tables !== 'object' || Array.isArray(b.tables)) {
    return { ok: false, error: 'This backup is missing its data tables.' };
  }
  for (const [name, rows] of Object.entries(b.tables as Record<string, unknown>)) {
    if (!Array.isArray(rows)) {
      return { ok: false, error: `Table "${name}" is corrupted (expected a list of rows).` };
    }
  }
  const settings =
    b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings)
      ? (b.settings as Record<string, unknown>)
      : {};
  return {
    ok: true,
    backup: {
      format: BACKUP_FORMAT,
      db_version: Number(b.db_version) || 0,
      app_version: typeof b.app_version === 'string' ? b.app_version : '',
      exported_at: typeof b.exported_at === 'string' ? b.exported_at : '',
      tables: b.tables as Record<string, unknown[]>,
      settings,
    },
  };
}

// ──────────────────────────────────────────────────────────────
// Filename helpers.
// ──────────────────────────────────────────────────────────────

/** `2026-07-04T16:10:53.160Z` → `2026-07-04-1610`. Falls back to date-only on bad input. */
export function backupDateStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'export';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
