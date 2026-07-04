import { describe, it, expect } from 'vitest';
import {
  csvField,
  toCsv,
  formatMoneyCell,
  formatCsvTimestamp,
  submissionsToCsv,
  submissionToRow,
  dailyRollupsToCsv,
  groupAggToCsv,
  forecastToCsv,
  analyticsToJson,
  buildBackup,
  validateBackup,
  summarizeBackup,
  backupDateStamp,
  BACKUP_FORMAT,
} from '../export-data';
import { parseCsv, parseMoneyCell, parseCsvTimestamp, parseProlificCsv } from '../import-csv';
import type { SubmissionRecord } from '../db';
import type { DailyRollup, GroupAgg } from '../earnings';

// ── CSV serialiser ────────────────────────────────────────────

describe('csvField', () => {
  it('leaves simple values unquoted', () => {
    expect(csvField('hello')).toBe('hello');
    expect(csvField(42)).toBe('42');
    expect(csvField('')).toBe('');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('quotes and escapes fields with delimiters, quotes, or newlines', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('toCsv ↔ parseCsv round-trip', () => {
  it('survives a round-trip through the importer tokeniser', () => {
    const rows = [
      ['Study', 'Reward', 'Note'],
      ['Simple', '$7.50', 'ok'],
      ['Has, comma', '£2.00', 'quote " inside'],
      ['New\nline', '€1.00', ''],
    ];
    const parsed = parseCsv(toCsv(rows));
    expect(parsed).toEqual(rows);
  });
});

// ── money / timestamp inverse of import-csv ───────────────────

describe('formatMoneyCell ↔ parseMoneyCell', () => {
  const cases: [number, string][] = [
    [750, 'USD'],
    [267, 'GBP'],
    [420, 'EUR'],
    [1000, 'CAD'],
    [525, 'AUD'],
    [5025, 'SEK'], // ambiguous symbol → falls back to `amount CODE`
    [9999, 'NOK'],
    [1, 'JPY'],
    [123456, 'BRL'],
  ];
  for (const [minor, currency] of cases) {
    it(`round-trips ${minor} ${currency}`, () => {
      const cell = formatMoneyCell(minor, currency);
      expect(parseMoneyCell(cell)).toEqual({ amount_minor: minor, currency });
    });
  }

  it('does not use the ambiguous kr symbol for SEK/NOK/DKK', () => {
    expect(formatMoneyCell(5000, 'NOK')).toBe('50.00 NOK');
    expect(formatMoneyCell(5000, 'DKK')).toBe('50.00 DKK');
  });
});

describe('formatCsvTimestamp ↔ parseCsvTimestamp', () => {
  it('round-trips an ISO timestamp through the importer parser', () => {
    const iso = '2026-03-25T16:10:53.160Z';
    const cell = formatCsvTimestamp(iso);
    expect(cell).toBe('2026-03-25 16:10:53.160000');
    expect(parseCsvTimestamp(cell)).toBe(iso);
  });

  it('handles midnight and single-digit fields with padding', () => {
    const iso = '2026-01-05T04:03:02.000Z';
    expect(parseCsvTimestamp(formatCsvTimestamp(iso))).toBe(iso);
  });

  it('returns empty string for missing/invalid input', () => {
    expect(formatCsvTimestamp('')).toBe('');
    expect(formatCsvTimestamp(null)).toBe('');
    expect(formatCsvTimestamp('not-a-date')).toBe('');
  });
});

// ── submissions → CSV round-trip through the real importer ────

function makeRecord(overrides: Partial<SubmissionRecord> & { payload?: Record<string, unknown> } = {}): SubmissionRecord {
  return {
    submission_id: 'csv:ABC123',
    study_id: 'csv:my-study',
    study_name: 'My Study',
    participant_id: 'csv-import',
    status: 'APPROVED',
    phase: 'submitted',
    observed_at: '2026-03-25T16:10:53.160Z',
    updated_at: '2026-03-25T16:10:53.160Z',
    payload: {
      study: { name: 'My Study' },
      _source: 'csv-import',
      submission_reward: { amount: 750, currency: 'USD' },
      started_at: '2026-03-25T15:40:00.000Z',
      completed_at: '2026-03-25T16:10:53.160Z',
      completion_code: 'ABC123',
    },
    ...overrides,
  };
}

/** Strip fields the importer regenerates from wall-clock time so records compare cleanly. */
function stable(r: SubmissionRecord) {
  const { updated_at: _u, ...rest } = r;
  return rest;
}

describe('submissionsToCsv round-trips through parseProlificCsv', () => {
  it('preserves an approved submission with reward, bonus, and both timestamps', () => {
    const original = makeRecord({
      payload: {
        study: { name: 'Bonus Study' },
        _source: 'csv-import',
        submission_reward: { amount: 500, currency: 'GBP' },
        bonus_payments: [{ amount: 150, currency: 'GBP' }],
        started_at: '2026-03-25T15:40:00.000Z',
        completed_at: '2026-03-25T16:10:53.160Z',
        completion_code: 'BON999',
      },
      submission_id: 'csv:BON999',
      study_id: 'csv:bonus-study',
      study_name: 'Bonus Study',
      status: 'APPROVED',
    });
    const csv = submissionsToCsv([original]);
    const reimported = parseProlificCsv(csv);
    expect(reimported.records).toHaveLength(1);
    expect(stable(reimported.records[0])).toEqual(stable(original));
  });

  it('preserves a RETURNED submission (returned_at ↔ Completed at column)', () => {
    const original = makeRecord({
      status: 'RETURNED',
      submission_id: 'csv:RET1',
      study_id: 'csv:returned-study',
      study_name: 'Returned Study',
      observed_at: '2026-03-25T16:10:53.160Z',
      payload: {
        study: { name: 'Returned Study' },
        _source: 'csv-import',
        submission_reward: { amount: 300, currency: 'EUR' },
        started_at: '2026-03-25T15:40:00.000Z',
        returned_at: '2026-03-25T16:10:53.160Z',
        completion_code: 'RET1',
      },
    });
    const reimported = parseProlificCsv(submissionsToCsv([original]));
    expect(reimported.records).toHaveLength(1);
    expect(stable(reimported.records[0])).toEqual(stable(original));
  });

  it('round-trips a whole CSV: parse → export → parse is a fixed point', () => {
    const csv = [
      'Study,Reward,Bonus,Started at,Completed at,Completion code,Status',
      'Study A,$7.50,,2026-03-25 15:40:00.000000,2026-03-25 16:10:53.160000,AAA111,APPROVED',
      'Study B,£2.00,£0.50,2026-03-24 10:00:00.000000,2026-03-24 10:30:00.000000,BBB222,AWAITING REVIEW',
      'Study C,€3.00,,2026-03-23 09:00:00.000000,2026-03-23 09:20:00.000000,CCC333,RETURNED',
    ].join('\n');
    const first = parseProlificCsv(csv).records;
    const second = parseProlificCsv(submissionsToCsv(first)).records;
    expect(second.map(stable)).toEqual(first.map(stable));
  });

  it('emits a header even with no records', () => {
    const csv = submissionsToCsv([]);
    expect(csv.split('\r\n')[0]).toContain('Study');
    expect(parseProlificCsv(csv).records).toHaveLength(0);
  });

  it('omits a zero bonus', () => {
    const row = submissionToRow(
      makeRecord({ payload: { ...makeRecord().payload, bonus_payments: [{ amount: 0, currency: 'USD' }] } }),
    );
    // Bonus column (index 4) should be blank.
    expect(row[4]).toBe('');
  });

  // ── Adversarial: hostile study names + degenerate rows ──────
  it('round-trips study names containing commas, quotes, and newlines', () => {
    const nasty = 'Weird, "Quoted"\nName';
    const original = makeRecord({
      study_name: nasty,
      submission_id: 'csv:NASTY1',
      study_id: `csv:${'weird-quoted-name'}`,
      observed_at: '2026-02-01T10:20:00.000Z', // importer derives this from completed_at
      payload: {
        study: { name: nasty },
        _source: 'csv-import',
        submission_reward: { amount: 250, currency: 'GBP' },
        started_at: '2026-02-01T10:00:00.000Z',
        completed_at: '2026-02-01T10:20:00.000Z',
        completion_code: 'NASTY1',
      },
    });
    const reimported = parseProlificCsv(submissionsToCsv([original]));
    expect(reimported.records).toHaveLength(1);
    expect(reimported.records[0].study_name).toBe(nasty);
    expect(stable(reimported.records[0])).toEqual(stable(original));
  });

  it('exports a submission with no reward and no bonus without crashing', () => {
    const row = submissionToRow(
      makeRecord({
        payload: {
          study: { name: 'No Reward' },
          _source: 'csv-import',
          started_at: '2026-02-01T10:00:00.000Z',
          completed_at: '2026-02-01T10:05:00.000Z',
          completion_code: 'NR1',
        },
      }),
    );
    expect(row[3]).toBe(''); // reward blank
    expect(row[4]).toBe(''); // bonus blank
  });

  // ── Native (live-API) payload shape — different field names than CSV ──
  // Live submissions store `study_code` + `submission_bonuses`; CSV-imported
  // ones store `completion_code` + `bonus_payments`. Export must read both.
  function makeNativeRecord(): SubmissionRecord {
    return {
      submission_id: 'sub-native-1',
      study_id: 'study-abc',
      study_name: 'Native Study',
      participant_id: 'real-participant',
      status: 'APPROVED',
      phase: 'submitted',
      observed_at: '2026-04-01T12:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
      payload: {
        study: { name: 'Native Study' },
        study_code: 'NATIVE99',
        submission_reward: { amount: 500, currency: 'GBP' },
        submission_bonuses: [
          { amount: 100, currency: 'GBP' },
          { amount: 50, currency: 'GBP' },
        ],
        started_at: '2026-04-01T11:30:00.000Z',
        completed_at: '2026-04-01T12:00:00.000Z',
      },
    };
  }

  it('exports the completion code from a native `study_code` field', () => {
    const row = submissionToRow(makeNativeRecord());
    expect(row[7]).toBe('NATIVE99'); // completion code column
  });

  it('sums native `submission_bonuses` into the Bonus column', () => {
    const row = submissionToRow(makeNativeRecord());
    expect(row[4]).toBe('£1.50'); // 100 + 50 minor = £1.50
  });

  it('preserves code + bonus when a native submission round-trips to CSV', () => {
    const reimported = parseProlificCsv(submissionsToCsv([makeNativeRecord()]));
    expect(reimported.records).toHaveLength(1);
    const r = reimported.records[0];
    // Re-imported as a csv: record, but the identity-bearing fields survive.
    expect(r.study_name).toBe('Native Study');
    expect(r.payload.completion_code).toBe('NATIVE99');
    expect(r.payload.bonus_payments).toEqual([{ amount: 150, currency: 'GBP' }]);
    expect(r.payload.submission_reward).toEqual({ amount: 500, currency: 'GBP' });
  });

  it('serialises a large batch without error', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      makeRecord({
        submission_id: `csv:B${i}`,
        study_name: `Study ${i}`,
        payload: { ...makeRecord().payload, completion_code: `B${i}` },
      }),
    );
    const csv = submissionsToCsv(many);
    expect(csv.split('\r\n')).toHaveLength(501); // header + 500
  });
});

// ── analytics serialisers ─────────────────────────────────────

describe('analytics CSV serialisers', () => {
  const rollups: DailyRollup[] = [
    {
      date_key: '2026-03-25',
      reward_minor: 1234,
      currency: 'USD',
      submission_count: 3,
      first_started_at: null,
      last_completed_at: null,
      active_span_seconds: 3600,
      sum_duration_seconds: 1800,
      hourly_active_major: 12.34,
      hourly_focused_major: 24.68,
    },
  ];

  it('serialises daily rollups with a header row', () => {
    const parsed = parseCsv(dailyRollupsToCsv(rollups));
    expect(parsed[0]).toContain('Date');
    expect(parsed[1][0]).toBe('2026-03-25');
    expect(parsed[1][3]).toBe('12.34'); // reward major
  });

  it('serialises group aggregates (researcher/study) with the given key header', () => {
    const groups: GroupAgg[] = [
      { key: 'r1', label: 'Dr Test', submission_count: 4, reward_minor: 2000, currency: 'GBP', hourly_rates: [10, 12, 14] },
    ];
    const parsed = parseCsv(groupAggToCsv(groups, 'Researcher'));
    expect(parsed[0][0]).toBe('Researcher');
    expect(parsed[1][0]).toBe('Dr Test');
    expect(parsed[1][4]).toBe('20.00');
    expect(parsed[1][5]).toBe('12'); // mean of 10,12,14
  });

  it('serialises a forecast', () => {
    const parsed = parseCsv(forecastToCsv([{ date_key: '2026-07-05', median: 30, p25: 20, p75: 45 }], 'USD'));
    expect(parsed[0]).toContain('Projected (median)');
    expect(parsed[1]).toEqual(['2026-07-05', 'USD', '30', '20', '45']);
  });

  it('emits configurable JSON with only the requested sections', () => {
    const json = analyticsToJson({ currency: 'USD', generated_at: '2026-07-04T00:00:00.000Z', daily: rollups });
    const obj = JSON.parse(json);
    expect(obj.currency).toBe('USD');
    expect(obj.daily).toHaveLength(1);
    expect(obj.researchers).toBeUndefined();
    expect(obj.forecast).toBeUndefined();
  });
});

// ── backup build / validate ───────────────────────────────────

describe('buildBackup / validateBackup / summarizeBackup', () => {
  const backup = buildBackup({
    tables: { submissions: [{ submission_id: 'a' }, { submission_id: 'b' }], researchers: [] },
    settings: { theme: 'dark', earningsPrefs: { primary_currency: 'USD' } },
    dbVersion: 3,
    appVersion: '1.3.1',
    exportedAt: '2026-07-04T16:10:53.160Z',
  });

  it('stamps the format tag and metadata', () => {
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.db_version).toBe(3);
    expect(backup.app_version).toBe('1.3.1');
  });

  it('validates a well-formed backup (object or JSON string)', () => {
    const fromObj = validateBackup(backup);
    expect(fromObj.ok).toBe(true);
    const fromStr = validateBackup(JSON.stringify(backup));
    expect(fromStr.ok).toBe(true);
  });

  it('rejects malformed input without throwing', () => {
    expect(validateBackup('not json{').ok).toBe(false);
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup(42).ok).toBe(false);
    expect(validateBackup({ format: 'something-else', tables: {} }).ok).toBe(false);
    expect(validateBackup({ format: BACKUP_FORMAT }).ok).toBe(false); // no tables
    expect(validateBackup({ format: BACKUP_FORMAT, tables: { submissions: 'nope' } }).ok).toBe(false);
  });

  it('defaults missing settings to an empty object', () => {
    const res = validateBackup({ format: BACKUP_FORMAT, tables: { submissions: [] } });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.backup.settings).toEqual({});
  });

  it('summarises table counts sorted by size', () => {
    const summary = summarizeBackup(backup);
    expect(summary.tableTotal).toBe(2);
    expect(summary.settingsCount).toBe(2);
    expect(summary.tables[0]).toEqual({ name: 'submissions', count: 2 });
  });
});

describe('backupDateStamp', () => {
  it('formats a stable filename stamp', () => {
    // Uses local time, so assert shape (TZ-independent) rather than exact date.
    expect(backupDateStamp('2026-07-04T16:10:53.160Z')).toMatch(/^\d{4}-\d{2}-\d{2}-\d{4}$/);
  });
  it('falls back for bad input', () => {
    expect(backupDateStamp('nope')).toBe('export');
  });
});
