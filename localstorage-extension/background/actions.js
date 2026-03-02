(() => {
  const root = globalThis.ProlificWatcherModules = globalThis.ProlificWatcherModules || {};

  function createPriorityActions(options) {
    const {
      chrome,
      nowIso,
      queryProlificTabs,
      extractStudyID,
      parseStudyIDFromProlificURL,
      studyURLFromID,
      pushDebugLog,
      bumpCounter,
      setState,
      limits,
      sounds
    } = options;

    let priorityAlertAudioContext = null;
    let priorityAlertPlayInFlight = false;
    let priorityAlertLastPlayedAt = 0;
    let priorityAlertSoundBase64PromiseByType = new Map();
    let priorityAlertSoundBufferPromiseByType = new Map();
    let priorityAlertSoundBufferContext = null;

    function canonicalPriorityAlertSoundType(value) {
      const raw = String(value || "").trim();
      if (sounds.types.has(raw)) {
        return raw;
      }
      return sounds.defaultType;
    }

    function getPriorityAlertAudioContext() {
      const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AudioContextCtor) {
        return null;
      }
      if (priorityAlertAudioContext) {
        return priorityAlertAudioContext;
      }
      try {
        priorityAlertAudioContext = new AudioContextCtor();
        return priorityAlertAudioContext;
      } catch {
        return null;
      }
    }

    function priorityAlertSoundBase64PathForType(soundType) {
      const normalized = canonicalPriorityAlertSoundType(soundType);
      return sounds.pathByType[normalized] || sounds.pathByType[sounds.defaultType];
    }

    async function getPriorityAlertSoundBase64(soundType) {
      const normalized = canonicalPriorityAlertSoundType(soundType);
      if (!priorityAlertSoundBase64PromiseByType.has(normalized)) {
        const path = priorityAlertSoundBase64PathForType(normalized);
        priorityAlertSoundBase64PromiseByType.set(normalized, (async () => {
          const response = await fetch(chrome.runtime.getURL(path));
          if (!response.ok) {
            throw new Error(`Failed to load ${normalized} sound.`);
          }
          return (await response.text()).replace(/\s+/g, "");
        })());
      }
      return priorityAlertSoundBase64PromiseByType.get(normalized);
    }

    async function getPriorityAlertSoundBuffer(audioContext, soundType) {
      const normalized = canonicalPriorityAlertSoundType(soundType);
      if (priorityAlertSoundBufferContext !== audioContext) {
        priorityAlertSoundBufferContext = audioContext;
        priorityAlertSoundBufferPromiseByType = new Map();
      }
      if (!priorityAlertSoundBufferPromiseByType.has(normalized)) {
        priorityAlertSoundBufferPromiseByType.set(normalized, (async () => {
          const base64 = await getPriorityAlertSoundBase64(normalized);
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
          }
          const arrayBuffer = bytes.buffer.slice(0);
          const decoded = await new Promise((resolve, reject) => {
            const maybePromise = audioContext.decodeAudioData(arrayBuffer, resolve, reject);
            if (maybePromise && typeof maybePromise.then === "function") {
              maybePromise.then(resolve).catch(reject);
            }
          });
          return decoded;
        })());
      }
      return priorityAlertSoundBufferPromiseByType.get(normalized);
    }

    async function playDefaultPriorityAlertTone(soundType, soundVolume) {
      const audioContext = getPriorityAlertAudioContext();
      if (!audioContext) {
        throw new Error("audio context unavailable");
      }
      if (audioContext.state === "suspended" && typeof audioContext.resume === "function") {
        await audioContext.resume();
      }

      const normalizedType = canonicalPriorityAlertSoundType(soundType);
      const normalizedVolume = Math.min(
        limits.maxAlertSoundVolume,
        Math.max(
          limits.minAlertSoundVolume,
          Number.parseInt(soundVolume, 10) || limits.defaultAlertSoundVolume
        )
      ) / 100;
      if (normalizedVolume <= 0) {
        return normalizedType;
      }
      const startTime = audioContext.currentTime + 0.03;
      const soundBuffer = await getPriorityAlertSoundBuffer(audioContext, normalizedType);
      const source = audioContext.createBufferSource();
      const gainNode = audioContext.createGain();
      source.buffer = soundBuffer;
      source.loop = false;
      gainNode.gain.setValueAtTime(Math.max(0, Math.min(2.5, Math.pow(normalizedVolume, 0.55) * 2.2)), startTime);
      source.connect(gainNode);
      gainNode.connect(audioContext.destination);
      source.onended = () => {
        try {
          source.disconnect();
          gainNode.disconnect();
        } catch {
          // Best effort cleanup.
        }
      };
      source.start(startTime);
      return normalizedType;
    }

    async function playPriorityAlertSound(trigger, studyCount, soundType, soundVolume) {
      const now = Date.now();
      if (priorityAlertPlayInFlight || now - priorityAlertLastPlayedAt < limits.alertCooldownMS) {
        return false;
      }

      priorityAlertPlayInFlight = true;
      try {
        const playedType = await playDefaultPriorityAlertTone(
          soundType,
          soundVolume
        );

        priorityAlertLastPlayedAt = now;
        await bumpCounter("priority_alert_sound_count", 1);
        await setState({
          priority_alert_last_at: nowIso(),
          priority_alert_last_trigger: trigger,
          priority_alert_last_study_count: studyCount,
          priority_alert_sound_mode: playedType
        });
        pushDebugLog("priority.alert.played", {
          trigger,
          study_count: studyCount,
          mode: playedType
        });
        return true;
      } catch (error) {
        pushDebugLog("priority.alert.error", {
          trigger,
          error: String(error && error.message ? error.message : error)
        });
        return false;
      } finally {
        priorityAlertPlayInFlight = false;
      }
    }

    async function handleAlertAction(filter, candidateStudies, trigger) {
      if (!candidateStudies.length) {
        return;
      }
      if (filter.alert_sound_enabled === false) {
        pushDebugLog("priority.alert.disabled", {
          trigger,
          candidate_count: candidateStudies.length
        });
        return;
      }
      await playPriorityAlertSound(
        trigger,
        candidateStudies.length,
        filter.alert_sound_type,
        filter.alert_sound_volume
      );
    }

    async function handleAutoOpenAction(filter, candidateStudies, trigger) {
      if (!candidateStudies.length) {
        return;
      }
      if (filter.auto_open_in_new_tab === false) {
        pushDebugLog("tab.priority_auto_open.disabled_new_tab", {
          trigger,
          candidate_count: candidateStudies.length
        });
        return;
      }

      const prolificTabs = await queryProlificTabs();
      const alreadyOpenStudyIDs = new Set();
      for (const tab of prolificTabs) {
        const studyID = parseStudyIDFromProlificURL(tab && tab.url);
        if (studyID) {
          alreadyOpenStudyIDs.add(studyID);
        }
      }

      let openedCount = 0;
      for (const study of candidateStudies) {
        if (openedCount >= limits.maxAutoOpenPerBatch) {
          break;
        }

        const studyID = extractStudyID(study);
        if (!studyID || alreadyOpenStudyIDs.has(studyID)) {
          continue;
        }

        const studyURL = studyURLFromID(studyID);
        if (!studyURL) {
          continue;
        }

        await chrome.tabs.create({
          url: studyURL,
          active: openedCount === 0
        });

        alreadyOpenStudyIDs.add(studyID);
        openedCount += 1;
        pushDebugLog("tab.priority_auto_open.created", {
          trigger,
          study_id: studyID,
          study_name: study && study.name ? String(study.name) : ""
        });
      }

      if (!openedCount) {
        pushDebugLog("tab.priority_auto_open.skip_existing_tab", {
          trigger,
          candidate_count: candidateStudies.length
        });
        return;
      }

      await bumpCounter("priority_study_auto_open_count", openedCount);
      await setState({
        priority_study_auto_open_last_at: nowIso(),
        priority_study_auto_open_last_trigger: trigger,
        priority_study_auto_open_last_count: openedCount
      });
    }

    return Object.freeze({
      canonicalPriorityAlertSoundType,
      handleAlertAction,
      handleAutoOpenAction
    });
  }

  root.actions = Object.freeze({
    createPriorityActions
  });
})();
