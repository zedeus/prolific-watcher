import { describe, it, expect } from 'vitest';
import type { Study, TelegramMessageFormatOptions, TelegramSentMessage } from '../types';
import {
  formatTelegramMessage,
  buildStudyReplyMarkup,
  buildSampleStudy,
  emptyReplyMarkup,
  telegramHtmlToPreviewHtml,
  trimStudyForTelegram,
  addSentMessages,
  pruneSentMessages,
  selectDepartedTracked,
  removeSentMessages,
  type SentMessageMap,
} from '../telegram-format';

const ALL_ON: TelegramMessageFormatOptions = {
  include_reward: true,
  include_hourly_rate: true,
  include_duration: true,
  include_places: true,
  include_researcher: true,
  include_tags: true,
  include_description: true,
  include_link: true,
};

function fmt(over: Partial<TelegramMessageFormatOptions>): TelegramMessageFormatOptions {
  return { ...ALL_ON, ...over };
}

function makeStudy(over: Partial<Study> = {}): Study {
  return { ...buildSampleStudy('2024-01-01T00:00:00.000Z'), ...over };
}

describe('formatTelegramMessage', () => {
  it('renders a bold title, and ❗️ + Filter line only when a filter name is given', () => {
    const study = makeStudy({ name: 'My Study' });
    const plain = formatTelegramMessage(study, null, fmt({}));
    expect(plain).toContain('<b>My Study</b>');
    expect(plain).not.toContain('❗️');
    expect(plain).not.toContain('Filter:');

    const matched = formatTelegramMessage(study, 'High pay', fmt({}));
    expect(matched).toContain('<b>❗️My Study</b>');
    expect(matched).toContain('<i>Filter: High pay</i>');
  });

  it('escapes HTML in the study name', () => {
    const study = makeStudy({ name: '<script>alert(1)</script>' });
    const out = formatTelegramMessage(study, null, fmt({}));
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });

  it('honours each include_ toggle', () => {
    const study = makeStudy({
      reward: { amount: 500, currency: 'GBP' },
      average_reward_per_hour: { amount: 1200, currency: 'GBP' },
      estimated_completion_time: 20,
      places_available: 7,
      researcher: { id: 'r', name: 'Dr Who', country: 'GB' },
      max_submissions_per_participant: 3,
      is_custom_screening: true,
      study_labels: ['survey'],
      description: '<p>Answer <b>questions</b> about things.</p>',
    });

    const full = formatTelegramMessage(study, null, fmt({}));
    expect(full).toContain('£5.00');
    expect(full).toContain('£12.00/hr');
    expect(full).toContain('20m');
    expect(full).toContain('7 places');
    expect(full).toContain('Dr Who');
    expect(full).toContain('Survey');
    expect(full).toContain('Multi-submit');
    expect(full).toContain('Screening');
    expect(full).toContain('Answer questions about things');

    const none = formatTelegramMessage(study, null, fmt({
      include_reward: false,
      include_hourly_rate: false,
      include_duration: false,
      include_places: false,
      include_researcher: false,
      include_tags: false,
      include_description: false,
    }));
    // Only the title line survives with everything off.
    expect(none).toBe(`<b>${study.name}</b>`);
    expect(none.split('\n')).toHaveLength(1);
  });

  it('pluralises places correctly', () => {
    expect(formatTelegramMessage(makeStudy({ places_available: 1 }), null, fmt({}))).toContain('1 place');
    expect(formatTelegramMessage(makeStudy({ places_available: 1 }), null, fmt({}))).not.toContain('1 places');
    expect(formatTelegramMessage(makeStudy({ places_available: 2 }), null, fmt({}))).toContain('2 places');
  });

  it('survives malformed / missing study fields without throwing', () => {
    const hostile = {
      id: 'x',
      name: '',
      reward: null,
      average_reward_per_hour: undefined,
      places_available: Number.NaN,
      researcher: undefined,
      study_labels: undefined,
      ai_inferred_study_labels: undefined,
      max_submissions_per_participant: undefined,
      description: undefined,
      estimated_completion_time: undefined,
    } as unknown as Study;
    expect(() => formatTelegramMessage(hostile, null, fmt({}))).not.toThrow();
    const out = formatTelegramMessage(hostile, null, fmt({}));
    expect(out).toContain('<b>Untitled Study</b>');
    expect(() => formatTelegramMessage(hostile, 'F', fmt({}), { unavailable: true })).not.toThrow();
  });

  it('handles layout-hostile names (very long, emoji, RTL, HTML) safely', () => {
    const name = '<b>' + '📊'.repeat(50) + 'مرحبا ' + 'x'.repeat(300);
    const out = formatTelegramMessage(makeStudy({ name }), null, fmt({}));
    expect(out).not.toContain('<b><b>'); // the injected <b> is escaped, not rendered
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('📊');
  });

  it('renders the unavailable variant: struck title, status line, no ❗️/Filter/places', () => {
    const study = makeStudy({ name: 'Gone Study', places_available: 5 });
    const out = formatTelegramMessage(study, 'High pay', fmt({}), { unavailable: true });
    expect(out).toContain('🚫 <b>No longer available</b>');
    expect(out).toContain('<s>Gone Study</s>');
    expect(out).not.toContain('❗️');
    expect(out).not.toContain('Filter:');
    expect(out).not.toContain('places');
    // reward/researcher detail still present so the user recognises which study.
    expect(out).toContain('£4.50');
  });
});

describe('buildStudyReplyMarkup / emptyReplyMarkup', () => {
  it('includes an Open study button only when include_link and an id are present', () => {
    const study = makeStudy({ id: 'abc123' });
    const markup = buildStudyReplyMarkup(study, fmt({}));
    expect(markup?.inline_keyboard[0][0].text).toContain('Open study');
    expect(markup?.inline_keyboard[0][0].url).toContain('abc123');

    expect(buildStudyReplyMarkup(study, fmt({ include_link: false }))).toBeUndefined();
    expect(buildStudyReplyMarkup(makeStudy({ id: '' }), fmt({}))).toBeUndefined();
  });

  it('emptyReplyMarkup strips the keyboard', () => {
    expect(emptyReplyMarkup()).toEqual({ inline_keyboard: [] });
  });
});

describe('telegramHtmlToPreviewHtml', () => {
  it('converts newlines to <br> and leaves style tags intact', () => {
    expect(telegramHtmlToPreviewHtml('<b>Title</b>\nline2\nline3')).toBe('<b>Title</b><br>line2<br>line3');
  });
});

describe('trimStudyForTelegram', () => {
  it('keeps formatter-relevant fields and compacts description', () => {
    const study = makeStudy({
      description: '<p>' + 'x'.repeat(400) + '</p>',
      device_compatibility: ['desktop', 'mobile'],
    });
    const trimmed = trimStudyForTelegram(study);
    expect(trimmed.id).toBe(study.id);
    expect(trimmed.reward).toEqual(study.reward);
    expect(trimmed.description.length).toBeLessThanOrEqual(200);
    expect(trimmed.description).not.toContain('<p>');
    // dropped heavy fields
    expect(trimmed.device_compatibility).toEqual([]);
    // re-formatting a trimmed study matches formatting the original (minus description length).
    const a = formatTelegramMessage(trimStudyForTelegram(makeStudy({ description: '' })), null, fmt({}));
    const b = formatTelegramMessage(makeStudy({ description: '' }), null, fmt({}));
    expect(a).toBe(b);
  });
});

describe('sent-message tracking helpers', () => {
  const entry = (id: string, sent_at: number): TelegramSentMessage => ({
    study_id: id,
    chat_id: 'c1',
    message_id: Number(id.replace(/\D/g, '')) || 1,
    sent_at,
    study: trimStudyForTelegram(makeStudy({ id, name: id })),
    filter_name: null,
  });

  it('addSentMessages merges, replaces, and caps to the oldest-evicted', () => {
    let map: SentMessageMap = {};
    map = addSentMessages(map, [entry('s1', 100), entry('s2', 200)], 10);
    expect(Object.keys(map).sort()).toEqual(['s1', 's2']);

    // replace s1 with a newer send
    map = addSentMessages(map, [entry('s1', 300)], 10);
    expect(map.s1.sent_at).toBe(300);

    // cap to 2 → oldest (s2 @200) evicted after adding s3 @400
    map = addSentMessages(map, [entry('s3', 400)], 2);
    expect(Object.keys(map).sort()).toEqual(['s1', 's3']);
    expect(map.s2).toBeUndefined();
  });

  it('addSentMessages ignores entries with no study_id', () => {
    const map = addSentMessages({}, [entry('', 100)], 10);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it('pruneSentMessages drops entries older than the TTL', () => {
    const map: SentMessageMap = { s1: entry('s1', 1000), s2: entry('s2', 5000) };
    const pruned = pruneSentMessages(map, 6000, 2000); // now=6000, ttl=2000 → cutoff 4000
    expect(pruned.s1).toBeUndefined();
    expect(pruned.s2).toBeDefined();
    expect(pruned).not.toBe(map);
  });

  it('pruneSentMessages returns the same reference when nothing is pruned', () => {
    const map: SentMessageMap = { s1: entry('s1', 5000), s2: entry('s2', 5500) };
    expect(pruneSentMessages(map, 6000, 2000)).toBe(map);
  });

  it('selectDepartedTracked returns only tracked departed studies', () => {
    const map: SentMessageMap = { s1: entry('s1', 100), s2: entry('s2', 200) };
    const departed = selectDepartedTracked(map, ['s2', 'sX']);
    expect(departed.map((d) => d.study_id)).toEqual(['s2']);
  });

  it('removeSentMessages returns the same reference when nothing to drop, new map otherwise', () => {
    const map: SentMessageMap = { s1: entry('s1', 100), s2: entry('s2', 200) };
    expect(removeSentMessages(map, [])).toBe(map);
    const next = removeSentMessages(map, ['s1']);
    expect(next).not.toBe(map);
    expect(Object.keys(next)).toEqual(['s2']);
  });
});
