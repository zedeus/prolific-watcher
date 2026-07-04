import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TELEGRAM_SENT_MESSAGES_KEY } from '../constants';

// ── Mock browser.storage.local (mirrors settings.test.ts) ───────────
const storage = new Map<string, unknown>();
vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const result: Record<string, unknown> = {};
          for (const k of keyList) if (storage.has(k)) result[k] = storage.get(k);
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

import {
  sendTelegramMessage,
  editTelegramMessage,
  loadSentTelegramMessages,
  saveSentTelegramMessages,
} from '../../entrypoints/background/telegram';

function mockFetchOnce(body: unknown, status = 200) {
  (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
    status,
    json: async () => body,
  });
}

beforeEach(() => {
  storage.clear();
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sendTelegramMessage', () => {
  it('captures the message_id from a successful send', async () => {
    mockFetchOnce({ ok: true, result: { message_id: 4242 } });
    const res = await sendTelegramMessage('t', 'c', 'hi');
    expect(res.ok).toBe(true);
    expect(res.message_id).toBe(4242);
  });

  it('coerces a string message_id to a number', async () => {
    mockFetchOnce({ ok: true, result: { message_id: '77' } });
    const res = await sendTelegramMessage('t', 'c', 'hi');
    expect(res.message_id).toBe(77);
  });

  it('returns ok with undefined message_id when Telegram omits result', async () => {
    mockFetchOnce({ ok: true });
    const res = await sendTelegramMessage('t', 'c', 'hi');
    expect(res.ok).toBe(true);
    expect(res.message_id).toBeUndefined();
  });

  it('classifies API errors and surfaces the description', async () => {
    mockFetchOnce({ ok: false, description: 'Unauthorized' }, 401);
    const res = await sendTelegramMessage('t', 'c', 'hi');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Invalid bot token');
    expect(res.description).toBe('Unauthorized');
  });

  it('returns an error (not a throw) on network failure', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const res = await sendTelegramMessage('t', 'c', 'hi');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('rejects missing args without hitting the network', async () => {
    const res = await sendTelegramMessage('', 'c', 'hi');
    expect(res.ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('includes reply_markup in the payload only when provided', async () => {
    mockFetchOnce({ ok: true, result: { message_id: 1 } });
    await sendTelegramMessage('t', 'c', 'hi', false, { inline_keyboard: [[{ text: 'x', url: 'u' }]] });
    const body = JSON.parse((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.reply_markup).toBeDefined();
    expect(body.parse_mode).toBe('HTML');
  });
});

describe('editTelegramMessage', () => {
  it('edits a message successfully', async () => {
    mockFetchOnce({ ok: true, result: { message_id: 5 } });
    const res = await editTelegramMessage('t', 'c', 5, 'new text', { inline_keyboard: [] });
    expect(res.ok).toBe(true);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain('/editMessageText');
    const body = JSON.parse(init.body);
    expect(body.message_id).toBe(5);
    expect(body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('treats "message is not modified" as success (idempotent)', async () => {
    mockFetchOnce({ ok: false, description: 'Bad Request: message is not modified' }, 400);
    const res = await editTelegramMessage('t', 'c', 5, 'same');
    expect(res.ok).toBe(true);
    expect(res.gone).toBeUndefined();
  });

  it('flags "message to edit not found" as gone', async () => {
    mockFetchOnce({ ok: false, description: 'Bad Request: message to edit not found' }, 400);
    const res = await editTelegramMessage('t', 'c', 5, 'x');
    expect(res.ok).toBe(false);
    expect(res.gone).toBe(true);
  });

  it("flags \"message can't be edited\" as gone", async () => {
    mockFetchOnce({ ok: false, description: "Bad Request: message can't be edited" }, 400);
    const res = await editTelegramMessage('t', 'c', 5, 'x');
    expect(res.gone).toBe(true);
  });

  it('surfaces other API errors without marking gone or retriable', async () => {
    mockFetchOnce({ ok: false, description: 'Forbidden: bot was blocked by the user' }, 403);
    const res = await editTelegramMessage('t', 'c', 5, 'x');
    expect(res.ok).toBe(false);
    expect(res.gone).toBeUndefined();
    expect(res.retriable).toBeFalsy();
    expect(res.error).toBeTruthy();
  });

  it('marks rate limits (429) and server errors (5xx) as retriable', async () => {
    mockFetchOnce({ ok: false, description: 'Too Many Requests: retry after 5' }, 429);
    expect((await editTelegramMessage('t', 'c', 5, 'x')).retriable).toBe(true);
    mockFetchOnce({ ok: false, description: 'Bad Gateway' }, 502);
    expect((await editTelegramMessage('t', 'c', 5, 'x')).retriable).toBe(true);
  });

  it('marks network failures as retriable (not gone)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    const res = await editTelegramMessage('t', 'c', 5, 'x');
    expect(res.ok).toBe(false);
    expect(res.gone).toBeUndefined();
    expect(res.retriable).toBe(true);
    expect(res.error).toBeTruthy();
  });

  it('rejects missing args (0 message id) without hitting the network', async () => {
    const res = await editTelegramMessage('t', 'c', 0, 'x');
    expect(res.ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('sent-message storage', () => {
  it('round-trips a map', async () => {
    await saveSentTelegramMessages({ s1: { study_id: 's1', chat_id: 'c', message_id: 1, sent_at: 100, study: {} as never, filter_name: null } });
    const loaded = await loadSentTelegramMessages();
    expect(loaded.s1.message_id).toBe(1);
  });

  it('returns {} when storage is empty', async () => {
    expect(await loadSentTelegramMessages()).toEqual({});
  });

  it('returns {} for corrupt storage (array / primitive / null)', async () => {
    for (const bad of [[1, 2, 3], 42, 'nope', null, true]) {
      storage.set(TELEGRAM_SENT_MESSAGES_KEY, bad);
      expect(await loadSentTelegramMessages()).toEqual({});
    }
  });
});
