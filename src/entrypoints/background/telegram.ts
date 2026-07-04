import { browser } from 'wxt/browser';
import type { TelegramSettings, TelegramMessageFormatOptions } from '../../lib/types';
import { TELEGRAM_SETTINGS_KEY, TELEGRAM_API_BASE_URL, TELEGRAM_SENT_MESSAGES_KEY } from '../../lib/constants';
import { toUserErrorMessage, nowIso } from '../../lib/format';
import {
  formatTelegramMessage,
  buildStudyReplyMarkup,
  buildSampleStudy,
  type ReplyMarkup,
  type SentMessageMap,
} from '../../lib/telegram-format';

// Re-export the shared formatter so existing background imports keep working.
export { formatTelegramMessage, buildStudyReplyMarkup } from '../../lib/telegram-format';

const BOT_TOKEN_REGEX = /^\d{5,16}:[A-Za-z0-9_-]{35}$/;

export function isValidBotTokenFormat(token: string): boolean {
  return BOT_TOKEN_REGEX.test(token.trim());
}

export function normalizeTelegramSettings(raw: unknown): TelegramSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fmt = (r.message_format && typeof r.message_format === 'object' ? r.message_format : {}) as Record<string, unknown>;

  return {
    enabled: r.enabled === true,
    bot_token: typeof r.bot_token === 'string' ? r.bot_token.trim() : '',
    chat_id: typeof r.chat_id === 'string' ? r.chat_id.trim() : '',
    notify_all_studies: r.notify_all_studies === true,
    silent_notifications: r.silent_notifications === true,
    message_format: {
      include_reward: fmt.include_reward !== false,
      include_hourly_rate: fmt.include_hourly_rate !== false,
      include_duration: fmt.include_duration !== false,
      include_places: fmt.include_places !== false,
      include_researcher: fmt.include_researcher !== false,
      include_tags: fmt.include_tags !== false,
      include_description: fmt.include_description === true,
      include_link: fmt.include_link !== false,
    },
  };
}

export function isTelegramConfigured(settings: TelegramSettings): boolean {
  return settings.enabled && settings.bot_token.length > 0 && settings.chat_id.length > 0;
}

export async function loadTelegramSettings(): Promise<TelegramSettings> {
  const data = await browser.storage.local.get(TELEGRAM_SETTINGS_KEY);
  return normalizeTelegramSettings(data[TELEGRAM_SETTINGS_KEY]);
}

export async function saveTelegramSettings(settings: TelegramSettings): Promise<TelegramSettings> {
  const normalized = normalizeTelegramSettings(settings);
  await browser.storage.local.set({ [TELEGRAM_SETTINGS_KEY]: normalized });
  return normalized;
}

function classifyTelegramError(status: number, description: string): string {
  if (status === 401) return 'Invalid bot token';
  if (status === 403) {
    if (description.includes('blocked')) return 'Bot was blocked by user';
    if (description.includes('initiate')) return 'Send /start to the bot first';
    return 'Bot cannot message this chat';
  }
  if (status === 400) {
    if (description.includes('chat not found')) return 'Chat ID not found';
    if (description.includes('PEER_ID_INVALID')) return 'Invalid chat ID — send /start to bot first';
    if (description.includes('too long')) return 'Message too long';
    if (description.includes('empty')) return 'Message is empty';
  }
  if (status === 429) {
    const match = description.match(/retry after (\d+)/i);
    return match ? `Rate limited — retry in ${match[1]}s` : 'Rate limited';
  }
  return description || `HTTP ${status}`;
}

// ─────────────────────────────────────────────────────────────
// Sent-message tracking storage (issue #27)
// ─────────────────────────────────────────────────────────────

export async function loadSentTelegramMessages(): Promise<SentMessageMap> {
  const data = await browser.storage.local.get(TELEGRAM_SENT_MESSAGES_KEY);
  const raw = data[TELEGRAM_SENT_MESSAGES_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as SentMessageMap) : {};
}

export async function saveSentTelegramMessages(map: SentMessageMap): Promise<void> {
  await browser.storage.local.set({ [TELEGRAM_SENT_MESSAGES_KEY]: map });
}

export interface SendTelegramResult {
  ok: boolean;
  /** Telegram message id of the sent message, when available (used for later edits). */
  message_id?: number;
  error?: string;
  description?: string;
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  silent: boolean = false,
  replyMarkup?: ReplyMarkup,
): Promise<SendTelegramResult> {
  if (!botToken || !chatId || !text) {
    return { ok: false, error: 'Missing bot token, chat ID, or message text' };
  }

  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: silent,
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const response = await fetch(`${TELEGRAM_API_BASE_URL}${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (result.ok) {
      const messageId = Number(result.result?.message_id);
      return { ok: true, message_id: Number.isFinite(messageId) ? messageId : undefined };
    }

    const description = String(result.description || '');
    return {
      ok: false,
      error: classifyTelegramError(response.status, description),
      description,
    };
  } catch (error) {
    return {
      ok: false,
      error: toUserErrorMessage(error),
    };
  }
}

export interface EditTelegramResult {
  ok: boolean;
  /** The message no longer exists on Telegram's side — caller should drop it from tracking. */
  gone?: boolean;
  /** Transient failure (rate limit / network) — the edit is worth retrying on a later refresh. */
  retriable?: boolean;
  error?: string;
  description?: string;
}

/**
 * Edit a previously-sent message's text and reply markup. Telegram treats "message is not modified"
 * as success (idempotent) and "message to edit not found" / "message can't be edited" as gone.
 * Rate limits (429) and network errors are flagged `retriable` so the caller can try again later.
 */
export async function editTelegramMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup?: ReplyMarkup,
): Promise<EditTelegramResult> {
  if (!botToken || !chatId || !messageId || !text) {
    return { ok: false, error: 'Missing bot token, chat ID, message ID, or text' };
  }

  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const response = await fetch(`${TELEGRAM_API_BASE_URL}${botToken}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (result.ok) return { ok: true };

    const description = String(result.description || '');
    const lower = description.toLowerCase();
    if (lower.includes('not modified')) return { ok: true };
    if (lower.includes('not found') || lower.includes("can't be edited") || lower.includes('cant be edited')) {
      return { ok: false, gone: true, description };
    }
    const retriable = response.status === 429 || response.status >= 500;
    return { ok: false, retriable, error: classifyTelegramError(response.status, description), description };
  } catch (error) {
    // Network/transport failure — retry on a later refresh.
    return { ok: false, retriable: true, error: toUserErrorMessage(error) };
  }
}

export interface VerifyBotResult {
  ok: boolean;
  bot_name?: string;
  bot_username?: string;
  error?: string;
}

export async function verifyTelegramBot(botToken: string): Promise<VerifyBotResult> {
  if (!botToken) {
    return { ok: false, error: 'Bot token is required' };
  }
  if (!isValidBotTokenFormat(botToken)) {
    return { ok: false, error: 'Invalid token format' };
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE_URL}${botToken}/getMe`, {
      method: 'GET',
    });
    const result = await response.json();

    if (result.ok && result.result) {
      return {
        ok: true,
        bot_name: result.result.first_name || '',
        bot_username: result.result.username || '',
      };
    }

    return { ok: false, error: classifyTelegramError(response.status, String(result.description || '')) };
  } catch (error) {
    return { ok: false, error: toUserErrorMessage(error) };
  }
}

export async function sendTelegramTestMessage(
  botToken: string,
  chatId: string,
  format: TelegramMessageFormatOptions,
): Promise<SendTelegramResult> {
  const sampleStudy = buildSampleStudy(nowIso());
  return sendTelegramMessage(
    botToken, chatId,
    formatTelegramMessage(sampleStudy, null, format),
    false,
    buildStudyReplyMarkup(sampleStudy, format),
  );
}
