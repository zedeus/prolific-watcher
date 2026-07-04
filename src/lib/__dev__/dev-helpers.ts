import { seedFakeSubmissions, clearFakeSubmissions } from './fake-submissions';
import { seedFakeStudies, seedSparseStudies, clearFakeStudies, wipeStudyData, seedSyncState, seedMutes, clearMutes } from './fake-studies';
import { devExportBackup, devRestoreBackup, devSeedResearchers, devCountTables } from './fake-backup';
import type { RestoreSummary } from '../backup';

declare global {
  interface Window {
    __ppDev?: {
      seed: (count: number, seed?: number) => Promise<number>;
      clear: () => Promise<void>;
      seedStudies: (count: number, seed?: number) => Promise<number>;
      seedSparseStudies: (count?: number, seed?: number) => Promise<number>;
      clearStudies: () => Promise<void>;
      wipeStudyData: () => Promise<void>;
      seedSyncState: (patch?: Record<string, unknown>) => Promise<void>;
      seedMutes: () => Promise<number>;
      clearMutes: () => Promise<void>;
      exportBackup: () => Promise<string>;
      restoreBackup: (json: string) => Promise<RestoreSummary>;
      seedResearchers: (count?: number) => Promise<number>;
      countTables: () => Promise<Record<string, number>>;
    };
  }
}

export function attachDevHelpers(): void {
  if (typeof window === 'undefined') return;
  window.__ppDev = {
    seed: seedFakeSubmissions,
    clear: clearFakeSubmissions,
    seedStudies: seedFakeStudies,
    seedSparseStudies,
    clearStudies: clearFakeStudies,
    wipeStudyData,
    seedSyncState,
    seedMutes,
    clearMutes,
    exportBackup: devExportBackup,
    restoreBackup: devRestoreBackup,
    seedResearchers: devSeedResearchers,
    countTables: devCountTables,
  };
}
