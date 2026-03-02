(() => {
  const root = globalThis.ProlificWatcherModules = globalThis.ProlificWatcherModules || {};

  function createPriorityState(options) {
    const {
      chrome,
      storageKey,
      nowIso,
      parseTimestampMS,
      normalizePrioritySnapshotEvent,
      limits,
      onQueueError
    } = options;

    let snapshotState = {
      initialized: false,
      knownStudyIDs: new Set()
    };
    let snapshotHydrated = false;
    let snapshotHydratePromise = null;
    let snapshotQueue = Promise.resolve();
    let alertSeenStudyIDs = new Map();
    let autoOpenSeenStudyIDs = new Map();

    function normalizeSnapshotFromStorage(rawSnapshot) {
      const nowMS = Date.now();
      const defaultSnapshot = {
        initialized: false,
        knownStudyIDs: new Set()
      };
      if (!rawSnapshot || typeof rawSnapshot !== "object") {
        return defaultSnapshot;
      }

      const updatedAtMS = parseTimestampMS(rawSnapshot.updated_at, 0);
      const isStale = !updatedAtMS || nowMS - updatedAtMS > limits.knownStudiesTTLMS;

      const rawEntries = rawSnapshot.entries && typeof rawSnapshot.entries === "object"
        ? rawSnapshot.entries
        : {};

      const entries = [];
      for (const [rawStudyID, rawSeenAtMS] of Object.entries(rawEntries)) {
        const studyID = typeof rawStudyID === "string" ? rawStudyID.trim() : "";
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
        knownStudyIDs: new Set(boundedEntries.map(([studyID]) => studyID))
      };
    }

    function buildSnapshotStoragePayload(snapshot, observedAtMS) {
      const entries = {};
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
        entries
      };
    }

    async function ensureHydrated() {
      if (snapshotHydrated) {
        return;
      }
      if (!snapshotHydratePromise) {
        snapshotHydratePromise = (async () => {
          try {
            const data = await chrome.storage.local.get(storageKey);
            snapshotState = normalizeSnapshotFromStorage(data[storageKey]);
          } catch {
            snapshotState = {
              initialized: false,
              knownStudyIDs: new Set()
            };
          } finally {
            snapshotHydrated = true;
          }
        })();
      }
      await snapshotHydratePromise;
    }

    async function persistSnapshot(snapshot, observedAtMS) {
      try {
        await chrome.storage.local.set({
          [storageKey]: buildSnapshotStoragePayload(snapshot, observedAtMS)
        });
      } catch {
        // Keep priority flow resilient if storage fails.
      }
    }

    function pruneSeenMap(seenStudyIDs, nowMS) {
      for (const [studyID, seenAtMS] of seenStudyIDs.entries()) {
        if (nowMS - seenAtMS > limits.actionSeenTTLMS) {
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

    function selectActionStudies(studies, seenStudyIDs, nowMS = Date.now()) {
      pruneSeenMap(seenStudyIDs, nowMS);
      const selected = [];
      for (const study of studies) {
        const studyID = study && typeof study.id === "string" ? study.id.trim() : "";
        if (!studyID || seenStudyIDs.has(studyID)) {
          continue;
        }
        selected.push(study);
      }
      return selected;
    }

    function markActionStudiesSeen(studies, seenStudyIDs, seenAtMS = Date.now()) {
      for (const study of studies) {
        const studyID = study && typeof study.id === "string" ? study.id.trim() : "";
        if (!studyID) {
          continue;
        }
        seenStudyIDs.set(studyID, seenAtMS);
      }
      pruneSeenMap(seenStudyIDs, seenAtMS);
    }

    function queueEvent(rawEvent, processor) {
      const event = normalizePrioritySnapshotEvent(rawEvent);
      snapshotQueue = snapshotQueue.then(async () => {
        await processor(event);
      }).catch((error) => {
        if (typeof onQueueError === "function") {
          onQueueError(error, event);
        }
      });
    }

    return Object.freeze({
      ensureHydrated,
      persistSnapshot,
      getSnapshot: () => snapshotState,
      setSnapshot: (nextSnapshot) => {
        snapshotState = nextSnapshot;
      },
      queueEvent,
      selectAlertCandidates: (studies, nowMS) => selectActionStudies(studies, alertSeenStudyIDs, nowMS),
      markAlertSeen: (studies, seenAtMS) => markActionStudiesSeen(studies, alertSeenStudyIDs, seenAtMS),
      selectAutoOpenCandidates: (studies, nowMS) => selectActionStudies(studies, autoOpenSeenStudyIDs, nowMS),
      markAutoOpenSeen: (studies, seenAtMS) => markActionStudiesSeen(studies, autoOpenSeenStudyIDs, seenAtMS),
      resetActionSeen: () => {
        alertSeenStudyIDs = new Map();
        autoOpenSeenStudyIDs = new Map();
      },
      getQueuePromise: () => snapshotQueue
    });
  }

  root.state = Object.freeze({
    createPriorityState
  });
})();
