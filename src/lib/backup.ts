import { db } from './db';
import { nowIso } from './format';
import {
  buildBackup,
  type BackupFile,
} from './export-data';

// ──────────────────────────────────────────────────────────────
// Backup / restore side-effects. Pure shaping + validation lives in
// export-data.ts; this module owns the IndexedDB + storage I/O so it
// stays thin and testable with fake-indexeddb.
// ──────────────────────────────────────────────────────────────

/** Minimal storage surface — lets tests inject an in-memory stand-in for browser.storage.local. */
export interface BackupStorage {
  getAll(): Promise<Record<string, unknown>>;
  setAll(items: Record<string, unknown>): Promise<void>;
}

/** Dump every Dexie table into a `{ tableName: rows }` map. */
export async function dumpTables(): Promise<Record<string, unknown[]>> {
  const tables: Record<string, unknown[]> = {};
  await db.transaction('r', db.tables, async () => {
    for (const table of db.tables) {
      tables[table.name] = await table.toArray();
    }
  });
  return tables;
}

export interface ExportBackupOptions {
  includeSettings?: boolean;
}

/** Build a full backup of the DB (+ optionally extension settings). */
export async function exportBackup(
  storage: BackupStorage,
  appVersion: string,
  opts: ExportBackupOptions = {},
): Promise<BackupFile> {
  const [tables, settings] = await Promise.all([
    dumpTables(),
    opts.includeSettings === false ? Promise.resolve({}) : storage.getAll(),
  ]);
  return buildBackup({
    tables,
    settings,
    dbVersion: db.verno,
    appVersion,
    exportedAt: nowIso(),
  });
}

export interface RestoreSummary {
  tablesRestored: number;
  rowsRestored: number;
  settingsRestored: number;
  skippedUnknownTables: string[];
}

export interface RestoreOptions {
  /** Also overwrite browser.storage.local from the backup's settings. Default true. */
  includeSettings?: boolean;
}

/**
 * Restore a validated backup over the local DB (and optionally settings).
 *
 * Only tables the backup actually contains are cleared + repopulated, all inside
 * one transaction (so a failure rolls the whole DB back). Tables NOT present in
 * the backup are left untouched — restoring an older or partial backup must not
 * silently wipe tables it doesn't know about. Unknown tables in the backup are
 * skipped (reported) rather than failing.
 *
 * Settings are merged over `storage.local` (not cleared first): this preserves
 * runtime-only keys such as the auth/`syncState` token so a restore doesn't sign
 * the user out, and avoids a clear-then-fail window that would lose settings.
 */
export async function restoreBackup(
  backup: BackupFile,
  storage: BackupStorage,
  opts: RestoreOptions = {},
): Promise<RestoreSummary> {
  const known = new Set(db.tables.map((t) => t.name));
  const skippedUnknownTables = Object.keys(backup.tables).filter((name) => !known.has(name));

  let tablesRestored = 0;
  let rowsRestored = 0;
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      const rows = backup.tables[table.name];
      if (!Array.isArray(rows)) continue; // table absent from backup → leave as-is
      await table.clear();
      if (rows.length > 0) {
        await table.bulkPut(rows as readonly unknown[] as never[]);
        rowsRestored += rows.length;
      }
      tablesRestored += 1;
    }
  });

  let settingsRestored = 0;
  if (opts.includeSettings !== false && backup.settings && Object.keys(backup.settings).length > 0) {
    await storage.setAll(backup.settings);
    settingsRestored = Object.keys(backup.settings).length;
  }

  return { tablesRestored, rowsRestored, settingsRestored, skippedUnknownTables };
}

/** Adapter over browser.storage.local for the real extension runtime. */
export function browserStorageAdapter(storageLocal: {
  get(keys?: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}): BackupStorage {
  return {
    getAll: () => storageLocal.get(null),
    setAll: (items) => storageLocal.set(items),
  };
}
