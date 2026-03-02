(() => {
  const root = globalThis.ProlificWatcherModules = globalThis.ProlificWatcherModules || {};

  function createPrioritySettings(options) {
    const {
      chrome,
      keys,
      limits,
      defaults,
      priorityAlertSoundTypes
    } = options;

    function normalizePriorityKeywordList(rawKeywords) {
      const values = Array.isArray(rawKeywords)
        ? rawKeywords
        : String(rawKeywords || "").split(",");

      const seen = new Set();
      const normalized = [];
      for (const value of values) {
        const keyword = String(value || "").trim().toLowerCase();
        if (!keyword || seen.has(keyword)) {
          continue;
        }
        seen.add(keyword);
        normalized.push(keyword);
        if (normalized.length >= limits.maxKeywords) {
          break;
        }
      }
      return normalized;
    }

    function canonicalPriorityAlertSoundType(value) {
      const raw = String(value || "").trim();
      if (priorityAlertSoundTypes.has(raw)) {
        return raw;
      }
      return defaults.alertSoundType;
    }

    function normalizePriorityStudyFilter(
      rawEnabled,
      rawAutoOpenInNewTab,
      rawAlertSoundEnabled,
      rawAlertSoundType,
      rawAlertSoundVolume,
      rawAlertSoundDurationMS,
      rawMinimumRewardMajor,
      rawMinimumHourlyRewardMajor,
      rawMaximumEstimatedMinutes,
      rawMinimumPlacesAvailable,
      rawAlwaysOpenKeywords,
      rawIgnoreKeywords
    ) {
      const parseNumber = (value, fallback) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          return fallback;
        }
        return parsed;
      };
      const parseInteger = (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed)) {
          return fallback;
        }
        return parsed;
      };

      const minimumRewardMajor = Math.min(
        limits.maxMinReward,
        Math.max(
          limits.minMinReward,
          parseNumber(rawMinimumRewardMajor, defaults.minimumRewardMajor)
        )
      );
      const minimumHourlyRewardMajor = Math.min(
        limits.maxMinHourlyReward,
        Math.max(
          limits.minMinHourlyReward,
          parseNumber(rawMinimumHourlyRewardMajor, defaults.minimumHourlyRewardMajor)
        )
      );
      const maximumEstimatedMinutes = Math.min(
        limits.maxEstimatedMinutes,
        Math.max(
          limits.minEstimatedMinutes,
          parseInteger(rawMaximumEstimatedMinutes, defaults.maximumEstimatedMinutes)
        )
      );
      const minimumPlacesAvailable = Math.min(
        limits.maxMinimumPlaces,
        Math.max(
          limits.minMinimumPlaces,
          parseInteger(rawMinimumPlacesAvailable, defaults.minimumPlacesAvailable)
        )
      );
      const alwaysOpenKeywords = normalizePriorityKeywordList(rawAlwaysOpenKeywords);
      const ignoreKeywords = normalizePriorityKeywordList(rawIgnoreKeywords);
      const normalizedAlertSoundType = canonicalPriorityAlertSoundType(rawAlertSoundType);
      const alertSoundVolume = Math.min(
        limits.maxAlertSoundVolume,
        Math.max(
          limits.minAlertSoundVolume,
          parseInteger(rawAlertSoundVolume, defaults.alertSoundVolume)
        )
      );
      const alertSoundDurationMS = Math.min(
        limits.maxAlertSoundDurationMS,
        Math.max(
          limits.minAlertSoundDurationMS,
          parseInteger(rawAlertSoundDurationMS, defaults.alertSoundDurationMS)
        )
      );

      return {
        enabled: rawEnabled === true,
        auto_open_in_new_tab: rawAutoOpenInNewTab !== false,
        alert_sound_enabled: rawAlertSoundEnabled !== false,
        alert_sound_type: normalizedAlertSoundType,
        alert_sound_volume: alertSoundVolume,
        alert_sound_duration_ms: alertSoundDurationMS,
        minimum_reward_major: Math.round(minimumRewardMajor * 100) / 100,
        minimum_hourly_reward_major: Math.round(minimumHourlyRewardMajor * 100) / 100,
        maximum_estimated_minutes: maximumEstimatedMinutes,
        minimum_places_available: minimumPlacesAvailable,
        always_open_keywords: alwaysOpenKeywords,
        ignore_keywords: ignoreKeywords
      };
    }

    async function getPriorityStudyFilterSettings() {
      const data = await chrome.storage.local.get([
        keys.enabled,
        keys.autoOpenInNewTab,
        keys.alertSoundEnabled,
        keys.alertSoundType,
        keys.alertSoundVolume,
        keys.alertSoundDurationMS,
        keys.minimumReward,
        keys.minimumHourlyReward,
        keys.maximumEstimatedMinutes,
        keys.minimumPlaces,
        keys.alwaysOpenKeywords,
        keys.ignoreKeywords
      ]);
      return normalizePriorityStudyFilter(
        data[keys.enabled] === true,
        data[keys.autoOpenInNewTab] !== false,
        data[keys.alertSoundEnabled] !== false,
        data[keys.alertSoundType],
        data[keys.alertSoundVolume],
        data[keys.alertSoundDurationMS],
        data[keys.minimumReward],
        data[keys.minimumHourlyReward],
        data[keys.maximumEstimatedMinutes],
        data[keys.minimumPlaces],
        data[keys.alwaysOpenKeywords],
        data[keys.ignoreKeywords]
      );
    }

    return Object.freeze({
      normalizePriorityKeywordList,
      canonicalPriorityAlertSoundType,
      normalizePriorityStudyFilter,
      getPriorityStudyFilterSettings
    });
  }

  root.settings = Object.freeze({
    createPrioritySettings
  });
})();
