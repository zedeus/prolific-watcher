import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../db';
import type { SubmissionRecord, ResearcherRecord } from '../db';
import {
  dumpTables,
  exportBackup,
  restoreBackup,
  browserStorageAdapter,
  type BackupStorage,
} from '../backup';
import { validateBackup, BACKUP_FORMAT } from '../export-data';

/** In-memory stand-in for browser.storage.local. */
function memStorage(initial: Record<string, unknown> = {}): BackupStorage & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    getAll: async () => ({ ...data }),
    setAll: async (items) => {
      Object.assign(data, items);
    },
  };
}

function sub(id: string): SubmissionRecord {
  return {
    submission_id: id,
    study_id: `study-${id}`,
    study_name: `Study ${id}`,
    participant_id: 'p1',
    status: 'APPROVED',
    phase: 'submitted',
    observed_at: '2026-03-25T16:10:53.160Z',
    updated_at: '2026-03-25T16:10:53.160Z',
    payload: { submission_reward: { amount: 500, currency: 'USD' } },
  };
}

function researcher(id: string): ResearcherRecord {
  return {
    id,
    name: `Researcher ${id}`,
    country: 'UK',
    first_seen_at: '2026-01-01T00:00:00.000Z',
    last_seen_at: '2026-03-01T00:00:00.000Z',
    study_count: 2,
    submission_count: 5,
  };
}

async function wipe() {
  await Promise.all(db.tables.map((t) => t.clear()));
}

describe('backup export/restore round-trip (fake-indexeddb)', () => {
  beforeEach(wipe);

  it('dumps every table', async () => {
    await db.submissions.bulkPut([sub('a'), sub('b')]);
    await db.researchers.bulkPut([researcher('r1')]);
    const tables = await dumpTables();
    expect(Object.keys(tables).sort()).toEqual(db.tables.map((t) => t.name).sort());
    expect(tables.submissions).toHaveLength(2);
    expect(tables.researchers).toHaveLength(1);
  });

  it('exports a valid backup including settings', async () => {
    await db.submissions.bulkPut([sub('a')]);
    const storage = memStorage({ theme: 'dark', earningsPrefs: { primary_currency: 'GBP' } });
    const backup = await exportBackup(storage, '1.3.1');
    expect(backup.format).toBe(BACKUP_FORMAT);
    expect(backup.settings.theme).toBe('dark');
    expect(validateBackup(JSON.stringify(backup)).ok).toBe(true);
  });

  it('restores DB + settings, replacing existing data', async () => {
    // Seed original data + settings, export.
    await db.submissions.bulkPut([sub('a'), sub('b'), sub('c')]);
    await db.researchers.bulkPut([researcher('r1'), researcher('r2')]);
    const storage = memStorage({ theme: 'dark', mutes: ['x'] });
    const backup = await exportBackup(storage, '1.3.1');

    // Mutate the DB + settings after the backup, and add a runtime-only key
    // (e.g. auth token) that isn't in the backup.
    await wipe();
    await db.submissions.bulkPut([sub('z')]);
    storage.data.theme = 'light';
    delete storage.data.mutes;
    storage.data.syncState = { token_ok: true };

    // Restore.
    const summary = await restoreBackup(backup, storage);
    const subs = await db.submissions.toArray();
    const researchers = await db.researchers.toArray();
    expect(subs.map((s) => s.submission_id).sort()).toEqual(['a', 'b', 'c']);
    expect(researchers).toHaveLength(2);
    expect(subs.find((s) => s.submission_id === 'z')).toBeUndefined();
    expect(storage.data.theme).toBe('dark');
    expect(storage.data.mutes).toEqual(['x']);
    // Merge (not clear) preserves runtime-only keys the backup didn't carry.
    expect(storage.data.syncState).toEqual({ token_ok: true });
    expect(summary.rowsRestored).toBe(5);
    expect(summary.settingsRestored).toBe(2);
  });

  it('honours includeSettings:false on restore (DB only, settings untouched)', async () => {
    await db.submissions.bulkPut([sub('a')]);
    const storage = memStorage({ theme: 'dark' });
    const backup = await exportBackup(storage, '1.3.1');
    storage.data.theme = 'light';
    await restoreBackup(backup, storage, { includeSettings: false });
    expect(storage.data.theme).toBe('light');
  });

  it('skips unknown tables in a backup rather than failing', async () => {
    await db.submissions.bulkPut([sub('a')]);
    const storage = memStorage();
    const backup = await exportBackup(storage, '1.3.1');
    backup.tables.someFutureTable = [{ x: 1 }];
    const summary = await restoreBackup(backup, storage);
    expect(summary.skippedUnknownTables).toContain('someFutureTable');
    // Known data still restored.
    expect(await db.submissions.count()).toBe(1);
  });

  it('leaves tables absent from the backup untouched (no silent wipe)', async () => {
    await db.submissions.bulkPut([sub('a')]);
    await db.researchers.bulkPut([researcher('r1')]);
    const storage = memStorage();
    const backup = await exportBackup(storage, '1.3.1');
    // Simulate an older/partial backup that predates the researchers table, then
    // add a live row. Restore must preserve it rather than wipe it.
    delete backup.tables.researchers;
    await db.researchers.bulkPut([researcher('r2')]);
    const summary = await restoreBackup(backup, storage);
    const ids = (await db.researchers.toArray()).map((r) => r.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
    expect(summary.tablesRestored).toBe(db.tables.length - 1);
  });

  it('browserStorageAdapter maps to a storage.local-shaped object', async () => {
    const store: Record<string, unknown> = { a: 1 };
    const adapter = browserStorageAdapter({
      get: async () => ({ ...store }),
      set: async (items) => {
        Object.assign(store, items);
      },
    });
    expect(await adapter.getAll()).toEqual({ a: 1 });
    await adapter.setAll({ b: 2 });
    expect(store).toEqual({ a: 1, b: 2 });
  });
});
