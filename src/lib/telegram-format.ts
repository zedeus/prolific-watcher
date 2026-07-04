import type { Study, TelegramMessageFormatOptions, TelegramSentMessage } from './types';
import {
  formatMoneyFromMinorUnits,
  formatDurationMinutes,
  compactText,
  studyUrlFromId,
  escapeHTML,
  stripHTML,
  formatStudyLabel,
} from './format';

/** Extra rendering options for {@link formatTelegramMessage}. */
export interface FormatTelegramMessageOptions {
  /** Render the "no longer available" variant (struck-through title + status line, no ❗️). */
  unavailable?: boolean;
}

function formatDetail(value: string): string | null {
  const v = value.trim();
  return v && v !== 'n/a' ? v : null;
}

/**
 * Render a study into the Telegram HTML message body. `filterName` is the name of the priority
 * filter that matched (drives the ❗️ prefix and trailing "Filter:" line), or null for
 * notify-all / test / preview messages.
 */
export function formatTelegramMessage(
  study: Study,
  filterName: string | null,
  format: TelegramMessageFormatOptions,
  opts: FormatTelegramMessageOptions = {},
): string {
  const lines: string[] = [];
  const title = escapeHTML(study.name || 'Untitled Study');

  if (opts.unavailable) {
    lines.push(`🚫 <b>No longer available</b>`);
    lines.push(`<s>${title}</s>`);
  } else {
    lines.push(filterName ? `<b>❗️${title}</b>` : `<b>${title}</b>`);
  }

  const details: string[] = [];
  if (format.include_reward) {
    const v = formatDetail(formatMoneyFromMinorUnits(study.reward));
    if (v) details.push(escapeHTML(v));
  }
  if (format.include_hourly_rate) {
    const v = formatDetail(formatMoneyFromMinorUnits(study.average_reward_per_hour));
    if (v) details.push(`${escapeHTML(v)}/hr`);
  }
  if (format.include_duration) {
    const v = formatDetail(formatDurationMinutes(study.estimated_completion_time));
    if (v) details.push(escapeHTML(v));
  }
  if (format.include_places && !opts.unavailable) {
    const places = Number(study.places_available);
    if (Number.isFinite(places)) details.push(`${places} place${places !== 1 ? 's' : ''}`);
  }
  if (format.include_researcher && study.researcher?.name) details.push(escapeHTML(study.researcher.name));
  if (details.length) lines.push(details.join(' · '));

  if (format.include_tags) {
    const tags: string[] = [];
    const typeLabel = formatStudyLabel(study.study_labels ?? [], study.ai_inferred_study_labels ?? []);
    if (typeLabel) tags.push(escapeHTML(typeLabel));
    if (study.max_submissions_per_participant > 1) tags.push('Multi-submit');
    if (study.is_custom_screening) tags.push('Screening');
    if (tags.length) lines.push(tags.join(' · '));
  }

  if (format.include_description && study.description) {
    const plain = stripHTML(study.description);
    if (plain) lines.push(`<i>${escapeHTML(compactText(plain, 200))}</i>`);
  }

  if (filterName && !opts.unavailable) {
    lines.push(`<i>Filter: ${escapeHTML(filterName)}</i>`);
  }

  return lines.join('\n');
}

export type InlineKeyboard = { text: string; url: string }[][];
export interface ReplyMarkup {
  inline_keyboard: InlineKeyboard;
}

/** Inline keyboard with an "Open study" button, or undefined when the link is disabled/absent. */
export function buildStudyReplyMarkup(
  study: Study,
  format: TelegramMessageFormatOptions,
): ReplyMarkup | undefined {
  if (!format.include_link || !study.id) return undefined;
  return { inline_keyboard: [[{ text: '📋 Open study', url: studyUrlFromId(study.id) }]] };
}

/** Empty inline keyboard — passed to editMessageText to strip the "Open study" button. */
export function emptyReplyMarkup(): ReplyMarkup {
  return { inline_keyboard: [] };
}

/**
 * Convert Telegram-flavoured HTML (only <b>/<i>/<s> style tags + escaped text) into HTML safe to
 * drop into a preview bubble. Newlines become <br>. No parsing needed — the style tags are already
 * valid HTML and all dynamic text was escaped by {@link formatTelegramMessage}.
 */
export function telegramHtmlToPreviewHtml(text: string): string {
  return text.replace(/\n/g, '<br>');
}

/** Fixed sample study used by the test-send and the settings preview (deterministic, all fields set). */
export function buildSampleStudy(nowIso: string): Study {
  return {
    id: 'sample000000000000000000',
    name: 'Sample Study — Test Notification',
    study_type: 'SINGLE',
    is_custom_screening: false,
    date_created: nowIso,
    published_at: nowIso,
    total_available_places: 50,
    places_taken: 12,
    places_available: 38,
    reward: { amount: 450, currency: 'GBP' },
    average_reward_per_hour: { amount: 900, currency: 'GBP' },
    max_submissions_per_participant: 1,
    researcher: { id: 'r1', name: 'Dr. Example', country: 'GB' },
    description: 'This is a test notification from Prolific Pulse to preview your message format.',
    estimated_completion_time: 15,
    device_compatibility: ['desktop'],
    peripheral_requirements: [],
    maximum_allowed_time: 1800,
    average_completion_time_in_seconds: 720,
    is_confidential: false,
    is_ongoing_study: false,
    pii_enabled: false,
    study_labels: ['survey'],
    ai_inferred_study_labels: [],
    previous_submission_count: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sent-message tracking (pure helpers — storage/network live in telegram.ts)
// ─────────────────────────────────────────────────────────────────────────────

export type SentMessageMap = Record<string, TelegramSentMessage>;

/**
 * Keep only the study fields {@link formatTelegramMessage} reads, so the persisted tracking map
 * stays small. Description is compacted to what the formatter would show anyway.
 */
export function trimStudyForTelegram(study: Study): Study {
  return {
    id: study.id,
    name: study.name,
    study_type: study.study_type,
    is_custom_screening: !!study.is_custom_screening,
    date_created: '',
    published_at: '',
    total_available_places: 0,
    places_taken: 0,
    places_available: Number(study.places_available) || 0,
    reward: study.reward ?? { amount: 0, currency: '' },
    average_reward_per_hour: study.average_reward_per_hour ?? { amount: 0, currency: '' },
    max_submissions_per_participant: Number(study.max_submissions_per_participant) || 0,
    researcher: study.researcher ?? { id: '', name: '', country: '' },
    description: study.description ? compactText(stripHTML(study.description), 200) : '',
    estimated_completion_time: Number(study.estimated_completion_time) || 0,
    device_compatibility: [],
    peripheral_requirements: [],
    maximum_allowed_time: 0,
    average_completion_time_in_seconds: 0,
    is_confidential: false,
    is_ongoing_study: false,
    pii_enabled: false,
    study_labels: Array.isArray(study.study_labels) ? study.study_labels : [],
    ai_inferred_study_labels: Array.isArray(study.ai_inferred_study_labels) ? study.ai_inferred_study_labels : [],
    previous_submission_count: 0,
  };
}

/**
 * Merge newly-sent messages into the map, then cap to `maxEntries` by evicting the oldest
 * (smallest `sent_at`). Returns a new map; inputs are not mutated.
 */
export function addSentMessages(
  map: SentMessageMap,
  entries: TelegramSentMessage[],
  maxEntries: number,
): SentMessageMap {
  const next: SentMessageMap = { ...map };
  for (const entry of entries) {
    if (entry.study_id) next[entry.study_id] = entry;
  }
  const ids = Object.keys(next);
  if (ids.length > maxEntries) {
    ids.sort((a, b) => next[a].sent_at - next[b].sent_at);
    for (const id of ids.slice(0, ids.length - maxEntries)) delete next[id];
  }
  return next;
}

/** Drop tracking entries older than `ttlMS`. Returns the same reference when nothing was pruned. */
export function pruneSentMessages(map: SentMessageMap, nowMS: number, ttlMS: number): SentMessageMap {
  const next: SentMessageMap = {};
  let pruned = false;
  for (const [id, entry] of Object.entries(map)) {
    if (nowMS - entry.sent_at < ttlMS) next[id] = entry;
    else pruned = true;
  }
  return pruned ? next : map;
}

/** Tracked entries whose study id appears in `departedStudyIDs` (i.e. gone from the feed). */
export function selectDepartedTracked(map: SentMessageMap, departedStudyIDs: string[]): TelegramSentMessage[] {
  const out: TelegramSentMessage[] = [];
  for (const id of departedStudyIDs) {
    const entry = map[id];
    if (entry) out.push(entry);
  }
  return out;
}

/** Remove the given study ids from the map. Returns a new map. */
export function removeSentMessages(map: SentMessageMap, studyIDs: string[]): SentMessageMap {
  if (!studyIDs.length) return map;
  const drop = new Set(studyIDs);
  const next: SentMessageMap = {};
  for (const [id, entry] of Object.entries(map)) {
    if (!drop.has(id)) next[id] = entry;
  }
  return next;
}
