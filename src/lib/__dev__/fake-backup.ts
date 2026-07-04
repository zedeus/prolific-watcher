// Dev-only helpers for exercising the export/backup feature (issue #23) in e2e.
// Attached to window.__ppDev in dev builds only — see dev-helpers.ts.
import { browser } from 'wxt/browser';
import { db } from '../db';
import type { ResearcherRecord } from '../db';
import { exportBackup, restoreBackup, browserStorageAdapter, type RestoreSummary } from '../backup';
import { validateBackup } from '../export-data';

function adapter() {
  return browserStorageAdapter(browser.storage.local);
}

/** Return the real backup JSON string (same path the "Back up all" button takes). */
export async function devExportBackup(): Promise<string> {
  const version = browser.runtime.getManifest().version;
  const backup = await exportBackup(adapter(), version);
  return JSON.stringify(backup);
}

/** Validate + restore a backup JSON string, returning the restore summary. */
export async function devRestoreBackup(json: string): Promise<RestoreSummary> {
  const res = validateBackup(json);
  if (!res.ok) throw new Error(res.error);
  return restoreBackup(res.backup, adapter());
}

/** Seed synthetic researcher rows so a backup has cross-table content. */
export async function devSeedResearchers(count = 5): Promise<number> {
  const rows: ResearcherRecord[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `dev-researcher-${i}`,
      name: `Dr Synthetic ${i}`,
      country: ['UK', 'US', 'DE', 'CA'][i % 4],
      first_seen_at: '2026-01-01T00:00:00.000Z',
      last_seen_at: '2026-06-01T00:00:00.000Z',
      study_count: (i % 5) + 1,
      submission_count: (i % 9) + 1,
    });
  }
  await db.researchers.bulkPut(rows);
  return rows.length;
}

/** Row counts per table — lets e2e assert a restore round-trip deterministically. */
export async function devCountTables(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of db.tables) out[table.name] = await table.count();
  return out;
}
