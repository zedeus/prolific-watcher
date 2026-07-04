import { seedFakeSubmissions, clearFakeSubmissions } from './fake-submissions';
import { seedFakeStudies, seedSparseStudies, clearFakeStudies, wipeStudyData, seedSyncState, seedMutes, clearMutes } from './fake-studies';

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
  };
}
