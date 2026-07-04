import { browser } from 'wxt/browser';
import type { Study } from '../../lib/types';
import { parseTimestampMS, normalizePrioritySnapshotEvent } from './domain';
import type { NormalizedSnapshotEvent, SnapshotState } from './domain';

export interface PriorityStateLimits {
  knownStudiesTTLMS: number;
  maxKnownStudies: number;
  actionSeenTTLMS: number;
  maxActionSeenStudies: number;
  telegramSeenTTLMS: number;
}

export interface CreatePriorityStateOptions {
  storageKey: string;
  nowIso: () => string;
  limits: PriorityStateLimits;
  onQueueError?: (error: unknown, event: NormalizedSnapshotEvent) => void;
}

interface StorageSnapshot {
  initialized?: boolean;
  updated_at?: string;
  entries?: Record<string, unknown>;
}

export interface PriorityState {
  ensureHydrated: () => Promise<void>;
  persistSnapshot: (snapshot: SnapshotState, observedAtMS: number) => Promise<void>;
  getSnapshot: () => SnapshotState;
  setSnapshot: (nextSnapshot: SnapshotState) => void;
  queueEvent: (rawEvent: unknown, processor: (event: NormalizedSnapshotEvent) => Promise<void>) => void;
  selectAlertCandidates: (studies: Study[], nowMS?: number) => Study[];
  markAlertSeen: (studies: Study[], seenAtMS?: number) => void;
  selectAutoOpenCandidates: (studies: Study[], nowMS?: number) => Study[];
  markAutoOpenSeen: (studies: Study[], seenAtMS?: number) => void;
  selectTelegramCandidates: (studies: Study[], nowMS?: number) => Study[];
  markTelegramSeen: (studies: Study[], seenAtMS?: number) => void;
  selectDesktopNotifyCandidates: (studies: Study[], nowMS?: number) => Study[];
  markDesktopNotifySeen: (studies: Study[], seenAtMS?: number) => void;
  markAttempted: (studyID: string) => void;
  clearSeenForAttemptedStudies: (removedStudyIDs: string[]) => void;
  resetActionSeen: () => void;
  getQueuePromise: () => Promise<void>;
}

export function createPriorityState(options: CreatePriorityStateOptions): PriorityState {
  const {
    storageKey,
    limits,
    onQueueError,
  } = options;

  let snapshotState: SnapshotState = {
    initialized: false,
    knownStudyIDs: new Set(),
  };
  let snapshotHydrated = false;
  let snapshotHydratePromise: Promise<void> | null = null;
  let snapshotQueue: Promise<void> = Promise.resolve();
  let alertSeenStudyIDs = new Map<string, number>();
  let autoOpenSeenStudyIDs = new Map<string, number>();
  let telegramSeenStudyIDs = new Map<string, number>();
  let desktopNotifySeenStudyIDs = new Map<string, number>();
  let attemptedStudyIDs = new Map<string, number>(); // studyID -> attemptedAtMS

  function normalizeSnapshotFromStorage(rawSnapshot: StorageSnapshot | null | undefined): SnapshotState {
    const nowMS = Date.now();
    const defaultSnapshot: SnapshotState = {
      initialized: false,
      knownStudyIDs: new Set(),
    };
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
      return defaultSnapshot;
    }

    const updatedAtMS = parseTimestampMS(rawSnapshot.updated_at, 0);
    const isStale = !updatedAtMS || nowMS - updatedAtMS > limits.knownStudiesTTLMS;

    const rawEntries = rawSnapshot.entries && typeof rawSnapshot.entries === 'object'
      ? rawSnapshot.entries
      : {};

    const entries: [string, number][] = [];
    for (const [rawStudyID, rawSeenAtMS] of Object.entries(rawEntries)) {
      const studyID = typeof rawStudyID === 'string' ? rawStudyID.trim() : '';
      if (!studyID) {
        continue;
      }
      const seenAtMS = parseTimestampMS(rawSeenAtMS, 0);
      if (!seenAtMS || nowMS - seenAtMS > limits.knownStudiesTTLMS) {
        continue;
      }
      entries.push([studyID, seenAtMS]);
    }

    entries.sort((a, b) => b[1] - a[1]);
    const boundedEntries = entries.slice(0, limits.maxKnownStudies);

    return {
      initialized: rawSnapshot.initialized === true && !isStale,
      knownStudyIDs: new Set(boundedEntries.map(([studyID]) => studyID)),
    };
  }

  function buildSnapshotStoragePayload(snapshot: SnapshotState, observedAtMS: number): StorageSnapshot {
    const entries: Record<string, number> = {};
    const seenAtMS = parseTimestampMS(observedAtMS);
    const studyIDs = snapshot && snapshot.knownStudyIDs instanceof Set
      ? Array.from(snapshot.knownStudyIDs)
      : [];
    const boundedStudyIDs = studyIDs.slice(0, limits.maxKnownStudies);
    for (const studyID of boundedStudyIDs) {
      entries[studyID] = seenAtMS;
    }
    return {
      initialized: snapshot && snapshot.initialized === true,
      updated_at: new Date(seenAtMS).toISOString(),
      entries,
    };
  }

  async function ensureHydrated(): Promise<void> {
    if (snapshotHydrated) {
      return;
    }
    if (!snapshotHydratePromise) {
      snapshotHydratePromise = (async () => {
        try {
          const data = await browser.storage.local.get(storageKey);
          snapshotState = normalizeSnapshotFromStorage(data[storageKey] as StorageSnapshot);
        } catch {
          snapshotState = {
            initialized: false,
            knownStudyIDs: new Set(),
          };
        } finally {
          snapshotHydrated = true;
        }
      })();
    }
    await snapshotHydratePromise;
  }

  async function persistSnapshot(snapshot: SnapshotState, observedAtMS: number): Promise<void> {
    try {
      await browser.storage.local.set({
        [storageKey]: buildSnapshotStoragePayload(snapshot, observedAtMS),
      });
    } catch {
      // Keep priority flow resilient if storage fails.
    }
  }

  function pruneSeenMap(seenStudyIDs: Map<string, number>, nowMS: number, ttlMS: number = limits.actionSeenTTLMS): void {
    for (const [studyID, seenAtMS] of seenStudyIDs.entries()) {
      if (nowMS - seenAtMS > ttlMS) {
        seenStudyIDs.delete(studyID);
      }
    }
    if (seenStudyIDs.size <= limits.maxActionSeenStudies) {
      return;
    }
    const ordered = Array.from(seenStudyIDs.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limits.maxActionSeenStudies);
    seenStudyIDs.clear();
    for (const [studyID, seenAtMS] of ordered) {
      seenStudyIDs.set(studyID, seenAtMS);
    }
  }

  function selectActionStudies(studies: Study[], seenStudyIDs: Map<string, number>, nowMS: number = Date.now(), ttlMS?: number): Study[] {
    pruneSeenMap(seenStudyIDs, nowMS, ttlMS);
    const selected: Study[] = [];
    for (const study of studies) {
      const studyID = study && typeof study.id === 'string' ? study.id.trim() : '';
      if (!studyID || seenStudyIDs.has(studyID)) {
        continue;
      }
      selected.push(study);
    }
    return selected;
  }

  function markActionStudiesSeen(studies: Study[], seenStudyIDs: Map<string, number>, seenAtMS: number = Date.now(), ttlMS?: number): void {
    for (const study of studies) {
      const studyID = study && typeof study.id === 'string' ? study.id.trim() : '';
      if (!studyID) {
        continue;
      }
      seenStudyIDs.set(studyID, seenAtMS);
    }
    pruneSeenMap(seenStudyIDs, seenAtMS, ttlMS);
  }

  function queueEvent(rawEvent: unknown, processor: (event: NormalizedSnapshotEvent) => Promise<void>): void {
    const event = normalizePrioritySnapshotEvent(rawEvent);
    snapshotQueue = snapshotQueue.then(async () => {
      await processor(event);
    }).catch((error) => {
      if (typeof onQueueError === 'function') {
        onQueueError(error, event);
      }
    });
  }

  function markAttempted(studyID: string): void {
    if (studyID) attemptedStudyIDs.set(studyID, Date.now());
    pruneSeenMap(attemptedStudyIDs, Date.now());
  }

  function clearSeenForAttemptedStudies(removedStudyIDs: string[]): void {
    pruneSeenMap(attemptedStudyIDs, Date.now());
    for (const studyID of removedStudyIDs) {
      if (attemptedStudyIDs.has(studyID)) {
        // User attempted this study (clicked "Take part") and it disappeared
        // (likely full). Clear from seen maps so it re-alerts when it reappears.
        alertSeenStudyIDs.delete(studyID);
        autoOpenSeenStudyIDs.delete(studyID);
        desktopNotifySeenStudyIDs.delete(studyID);
        attemptedStudyIDs.delete(studyID);
      }
    }
  }

  return Object.freeze({
    ensureHydrated,
    persistSnapshot,
    getSnapshot: (): SnapshotState => snapshotState,
    setSnapshot: (nextSnapshot: SnapshotState): void => {
      snapshotState = nextSnapshot;
    },
    queueEvent,
    selectAlertCandidates: (studies: Study[], nowMS?: number): Study[] => selectActionStudies(studies, alertSeenStudyIDs, nowMS),
    markAlertSeen: (studies: Study[], seenAtMS?: number): void => markActionStudiesSeen(studies, alertSeenStudyIDs, seenAtMS),
    selectAutoOpenCandidates: (studies: Study[], nowMS?: number): Study[] => selectActionStudies(studies, autoOpenSeenStudyIDs, nowMS),
    markAutoOpenSeen: (studies: Study[], seenAtMS?: number): void => markActionStudiesSeen(studies, autoOpenSeenStudyIDs, seenAtMS),
    selectTelegramCandidates: (studies: Study[], nowMS?: number): Study[] => selectActionStudies(studies, telegramSeenStudyIDs, nowMS, limits.telegramSeenTTLMS),
    markTelegramSeen: (studies: Study[], seenAtMS?: number): void => markActionStudiesSeen(studies, telegramSeenStudyIDs, seenAtMS, limits.telegramSeenTTLMS),
    selectDesktopNotifyCandidates: (studies: Study[], nowMS?: number): Study[] => selectActionStudies(studies, desktopNotifySeenStudyIDs, nowMS),
    markDesktopNotifySeen: (studies: Study[], seenAtMS?: number): void => markActionStudiesSeen(studies, desktopNotifySeenStudyIDs, seenAtMS),
    markAttempted,
    clearSeenForAttemptedStudies,
    resetActionSeen: (): void => {
      alertSeenStudyIDs = new Map();
      autoOpenSeenStudyIDs = new Map();
      telegramSeenStudyIDs = new Map();
      desktopNotifySeenStudyIDs = new Map();
      attemptedStudyIDs = new Map();
    },
    getQueuePromise: (): Promise<void> => snapshotQueue,
  });
}
