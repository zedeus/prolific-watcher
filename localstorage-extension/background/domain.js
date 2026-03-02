(() => {
  const root = globalThis.ProlificWatcherModules = globalThis.ProlificWatcherModules || {};

  function createPriorityDomain() {
    function moneyMajorValue(money) {
      if (!money || typeof money !== "object") {
        return NaN;
      }
      const rawAmount = Number(money.amount);
      if (!Number.isFinite(rawAmount)) {
        return NaN;
      }
      return rawAmount / 100;
    }

    function extractStudiesResults(payload) {
      if (!payload || typeof payload !== "object" || !Array.isArray(payload.results)) {
        return null;
      }
      return payload.results;
    }

    function extractStudyID(study) {
      const id = study && typeof study.id === "string" ? study.id.trim() : "";
      return id;
    }

    function studyHourlyRewardMajor(study) {
      const hourly = study && typeof study === "object"
        ? (study.study_average_reward_per_hour || study.average_reward_per_hour)
        : null;
      return moneyMajorValue(hourly);
    }

    function studyRewardMajor(study) {
      const reward = study && typeof study === "object"
        ? (study.study_reward || study.reward)
        : null;
      return moneyMajorValue(reward);
    }

    function studyEstimatedMinutes(study) {
      const minutes = Number(study && (study.estimated_completion_time || study.average_completion_time));
      if (!Number.isFinite(minutes)) {
        return NaN;
      }
      return minutes;
    }

    function studyPlacesAvailable(study) {
      const explicit = Number(study && study.places_available);
      if (Number.isFinite(explicit)) {
        return explicit;
      }
      const total = Number(study && study.total_available_places);
      const taken = Number(study && study.places_taken);
      if (!Number.isFinite(total)) {
        return NaN;
      }
      if (!Number.isFinite(taken)) {
        return total;
      }
      return Math.max(0, total - taken);
    }

    function studyKeywordBlob(study) {
      const labels = Array.isArray(study && study.study_labels) ? study.study_labels : [];
      const inferred = Array.isArray(study && study.ai_inferred_study_labels) ? study.ai_inferred_study_labels : [];
      return [
        study && study.name ? study.name : "",
        study && study.description ? study.description : "",
        ...labels,
        ...inferred
      ].join(" ").toLowerCase();
    }

    function hasAnyPriorityKeywordMatch(keywordBlob, keywords) {
      if (!Array.isArray(keywords) || !keywords.length) {
        return false;
      }
      return keywords.some((keyword) => keywordBlob.includes(keyword));
    }

    function studyMatchesPriorityFilter(study, filter) {
      const keywordBlob = studyKeywordBlob(study);
      if (hasAnyPriorityKeywordMatch(keywordBlob, filter.ignore_keywords)) {
        return false;
      }
      if (hasAnyPriorityKeywordMatch(keywordBlob, filter.always_open_keywords)) {
        return true;
      }

      const reward = studyRewardMajor(study);
      if (!Number.isFinite(reward) || reward < filter.minimum_reward_major) {
        return false;
      }

      const hourly = studyHourlyRewardMajor(study);
      if (!Number.isFinite(hourly) || hourly < filter.minimum_hourly_reward_major) {
        return false;
      }

      const estimatedMinutes = studyEstimatedMinutes(study);
      if (!Number.isFinite(estimatedMinutes) || estimatedMinutes > filter.maximum_estimated_minutes) {
        return false;
      }

      const placesAvailable = studyPlacesAvailable(study);
      if (!Number.isFinite(placesAvailable) || placesAvailable < filter.minimum_places_available) {
        return false;
      }
      return true;
    }

    function parseStudyIDFromProlificURL(rawURL) {
      if (!rawURL || typeof rawURL !== "string") {
        return "";
      }
      try {
        const parsed = new URL(rawURL);
        const match = parsed.pathname.match(/^\/studies\/([^/]+)\/?$/);
        if (!match || !match[1]) {
          return "";
        }
        return decodeURIComponent(match[1]);
      } catch {
        return "";
      }
    }

    function studyURLFromID(studyID) {
      const id = typeof studyID === "string" ? studyID.trim() : "";
      if (!id) {
        return "";
      }
      return `https://app.prolific.com/studies/${encodeURIComponent(id)}`;
    }

    function parseTimestampMS(value, fallbackMS = Date.now()) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(0, value);
      }
      const parsed = Date.parse(String(value || ""));
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      return fallbackMS;
    }

    function normalizeStudyIDList(rawStudyIDs) {
      if (!Array.isArray(rawStudyIDs) || !rawStudyIDs.length) {
        return [];
      }
      const unique = [];
      const seen = new Set();
      for (const rawStudyID of rawStudyIDs) {
        const studyID = typeof rawStudyID === "string" ? rawStudyID.trim() : "";
        if (!studyID || seen.has(studyID)) {
          continue;
        }
        seen.add(studyID);
        unique.push(studyID);
      }
      return unique;
    }

    function buildPriorityStudiesSnapshotFromStudies(studies) {
      const studiesByID = new Map();
      if (Array.isArray(studies)) {
        for (const study of studies) {
          const studyID = extractStudyID(study);
          if (!studyID || studiesByID.has(studyID)) {
            continue;
          }
          studiesByID.set(studyID, study);
        }
      }
      return {
        studyIDs: new Set(studiesByID.keys()),
        studiesByID
      };
    }

    function sortPriorityStudies(studies) {
      return studies.slice().sort((a, b) => {
        const hourlyDiff = studyHourlyRewardMajor(b) - studyHourlyRewardMajor(a);
        if (Number.isFinite(hourlyDiff) && hourlyDiff !== 0) {
          return hourlyDiff;
        }
        const placesDiff = studyPlacesAvailable(b) - studyPlacesAvailable(a);
        if (Number.isFinite(placesDiff) && placesDiff !== 0) {
          return placesDiff;
        }
        const aID = extractStudyID(a);
        const bID = extractStudyID(b);
        return aID.localeCompare(bID);
      });
    }

    function normalizePrioritySnapshotEvent(event) {
      const mode = event && event.mode === "delta" ? "delta" : "full";
      return {
        mode,
        trigger: String((event && event.trigger) || "unknown"),
        observedAtMS: parseTimestampMS(event && (event.observedAtMS ?? event.observedAt)),
        studies: Array.isArray(event && event.studies) ? event.studies : [],
        removedStudyIDs: normalizeStudyIDList(event && event.removedStudyIDs)
      };
    }

    function evaluatePrioritySnapshotEvent(previousSnapshot, rawEvent, filter) {
      const event = normalizePrioritySnapshotEvent(rawEvent);
      const priorStudyIDs = previousSnapshot && previousSnapshot.knownStudyIDs instanceof Set
        ? new Set(previousSnapshot.knownStudyIDs)
        : new Set();
      const wasInitialized = previousSnapshot && previousSnapshot.initialized === true;

      let nextStudyIDs = new Set(priorStudyIDs);
      let newlySeenStudies = [];

      if (event.mode === "delta") {
        for (const removedStudyID of event.removedStudyIDs) {
          nextStudyIDs.delete(removedStudyID);
        }

        const addedSnapshot = buildPriorityStudiesSnapshotFromStudies(event.studies);
        for (const [studyID, study] of addedSnapshot.studiesByID.entries()) {
          if (!nextStudyIDs.has(studyID)) {
            newlySeenStudies.push(study);
          }
          nextStudyIDs.add(studyID);
        }
      } else {
        const fullSnapshot = buildPriorityStudiesSnapshotFromStudies(event.studies);
        nextStudyIDs = fullSnapshot.studyIDs;
        for (const [studyID, study] of fullSnapshot.studiesByID.entries()) {
          if (!priorStudyIDs.has(studyID)) {
            newlySeenStudies.push(study);
          }
        }
      }

      const isBaseline = event.mode === "full" && !wasInitialized;
      const newPriorityStudies = !isBaseline && filter && filter.enabled
        ? sortPriorityStudies(newlySeenStudies.filter((study) => studyMatchesPriorityFilter(study, filter)))
        : [];

      return {
        event,
        nextSnapshot: {
          initialized: true,
          knownStudyIDs: nextStudyIDs
        },
        newlySeenStudies,
        newPriorityStudies,
        isBaseline
      };
    }

    return Object.freeze({
      moneyMajorValue,
      extractStudiesResults,
      extractStudyID,
      studyHourlyRewardMajor,
      studyRewardMajor,
      studyEstimatedMinutes,
      studyPlacesAvailable,
      studyKeywordBlob,
      hasAnyPriorityKeywordMatch,
      studyMatchesPriorityFilter,
      parseStudyIDFromProlificURL,
      studyURLFromID,
      parseTimestampMS,
      normalizeStudyIDList,
      buildPriorityStudiesSnapshotFromStudies,
      sortPriorityStudies,
      normalizePrioritySnapshotEvent,
      evaluatePrioritySnapshotEvent
    });
  }

  root.domain = Object.freeze({
    createPriorityDomain
  });
})();
