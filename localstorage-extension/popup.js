const autoOpenToggle = document.getElementById("autoOpenToggle");
const priorityFilterEnabledToggle = document.getElementById("priorityFilterEnabledToggle");
const priorityAutoOpenInNewTabToggle = document.getElementById("priorityAutoOpenInNewTabToggle");
const priorityAlertSoundToggle = document.getElementById("priorityAlertSoundToggle");
const priorityAlertSoundConfig = document.getElementById("priorityAlertSoundConfig");
const priorityAlertSoundTypeSelect = document.getElementById("priorityAlertSoundTypeSelect");
const priorityAlertSoundVolumeInput = document.getElementById("priorityAlertSoundVolumeInput");
const priorityAlertSoundPreviewButton = document.getElementById("priorityAlertSoundPreviewButton");
const priorityMinRewardInput = document.getElementById("priorityMinRewardInput");
const priorityMinHourlyInput = document.getElementById("priorityMinHourlyInput");
const priorityMaxEtaInput = document.getElementById("priorityMaxEtaInput");
const priorityMinPlacesInput = document.getElementById("priorityMinPlacesInput");
const priorityAlwaysKeywordsInput = document.getElementById("priorityAlwaysKeywordsInput");
const priorityIgnoreKeywordsInput = document.getElementById("priorityIgnoreKeywordsInput");
const syncDotEl = document.getElementById("syncDot");
const refreshPrefixEl = document.getElementById("refreshPrefix");
const latestRefreshEl = document.getElementById("latestRefresh");
const errorMessageEl = document.getElementById("errorMessage");
const liveStudiesEl = document.getElementById("liveStudies");
const eventsEl = document.getElementById("events");
const submissionsEl = document.getElementById("submissions");
const refreshDebugButton = document.getElementById("refreshDebugButton");
const clearDebugButton = document.getElementById("clearDebugButton");
const debugGridEl = document.getElementById("debugGrid");
const debugLogEl = document.getElementById("debugLog");
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const panelLive = document.getElementById("panelLive");
const panelFeed = document.getElementById("panelFeed");
const panelSubmissions = document.getElementById("panelSubmissions");
const panelSettings = document.getElementById("panelSettings");
const refreshMinDelayInput = document.getElementById("refreshMinDelayInput");
const refreshAverageDelayInput = document.getElementById("refreshAverageDelayInput");
const refreshSpreadInput = document.getElementById("refreshSpreadInput");
const refreshMinDelayValueEl = document.getElementById("refreshMinDelayValue");
const refreshAverageDelayValueEl = document.getElementById("refreshAverageDelayValue");
const refreshSpreadValueEl = document.getElementById("refreshSpreadValue");
const refreshCadenceActionsEl = document.getElementById("refreshCadenceActions");
const refreshCadenceSaveButton = document.getElementById("refreshCadenceSaveButton");
const refreshCadenceRevertButton = document.getElementById("refreshCadenceRevertButton");
const refreshPlanSummaryEl = document.getElementById("refreshPlanSummary");
const refreshPlanTrackEl = document.getElementById("refreshPlanTrack");

const SERVICE_OFFLINE_MESSAGE = "Local service offline, start the Go server to continue.";
const SERVICE_CONNECTING_MESSAGE = "Local service connecting; retrying shortly.";
const AUTH_REQUIRED_MESSAGE = "Signed out of Prolific. Log in at app.prolific.com to resume syncing.";
const AUTH_REQUIRED_PANEL_MESSAGE = "Waiting for login.";
const RETRY_INTERVAL_MS = 5000;
const DEFAULT_REFRESH_INTERVAL_MS = 60000;
const REACTIVE_REFRESH_DEBOUNCE_MS = 150;
const PRIORITY_FILTER_PERSIST_DEBOUNCE_MS = 250;
const REFRESH_CYCLE_SECONDS = 120;
const DEFAULT_REFRESH_MIN_DELAY_SECONDS = 20;
const DEFAULT_REFRESH_AVERAGE_DELAY_SECONDS = 30;
const DEFAULT_REFRESH_SPREAD_SECONDS = 0;
const MIN_REFRESH_MIN_DELAY_SECONDS = 1;
const MIN_REFRESH_AVERAGE_DELAY_SECONDS = 5;
const MAX_REFRESH_MIN_DELAY_SECONDS = 60;
const MAX_REFRESH_AVERAGE_DELAY_SECONDS = 60;
const MAX_REFRESH_SPREAD_SECONDS = 60;
const DEFAULT_PRIORITY_MIN_REWARD = 0;
const DEFAULT_PRIORITY_MIN_HOURLY_REWARD = 10;
const DEFAULT_PRIORITY_MAX_ESTIMATED_MINUTES = 20;
const DEFAULT_PRIORITY_MIN_PLACES = 1;
const MIN_PRIORITY_MIN_REWARD = 0;
const MAX_PRIORITY_MIN_REWARD = 100;
const MIN_PRIORITY_MIN_HOURLY_REWARD = 0;
const MAX_PRIORITY_MIN_HOURLY_REWARD = 100;
const MIN_PRIORITY_MAX_ESTIMATED_MINUTES = 1;
const MAX_PRIORITY_MAX_ESTIMATED_MINUTES = 240;
const MIN_PRIORITY_MIN_PLACES = 1;
const MAX_PRIORITY_MIN_PLACES = 1000;
const MAX_PRIORITY_KEYWORDS = 20;
const DEFAULT_PRIORITY_ALERT_SOUND_TYPE = "pay";
const DEFAULT_PRIORITY_ALERT_SOUND_VOLUME = 100;
const DEFAULT_PRIORITY_ALERT_SOUND_DURATION_MS = 1400;
const MIN_PRIORITY_ALERT_SOUND_VOLUME = 0;
const MAX_PRIORITY_ALERT_SOUND_VOLUME = 100;
const PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH = Object.freeze({
  pay: "sounds/pay.base64",
  metal_gear: "sounds/metal_gear.base64",
  twitch: "sounds/twitch.base64",
  chime: "sounds/chime.base64",
  money: "sounds/money.base64",
  samsung: "sounds/samsung.base64",
  lbp: "sounds/lbp.base64",
  taco: "sounds/taco.base64"
});
const PRIORITY_ALERT_SOUND_TYPES = new Set(Object.keys(PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH));
const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const DEBUG_EVENT_LABELS = Object.freeze({
  "token.sync.ok": "Token synced",
  "token.sync.error": "Token sync failed",
  "token.service_cleared": "Signed-out token cleared",
  "token.service_clear.error": "Token clear failed",
  "oauth.capture.ok": "OAuth token captured",
  "oauth.capture.error": "OAuth capture failed",
  "studies.refresh.post.ok": "Refresh forwarded",
  "studies.refresh.post.error": "Refresh forward failed",
  "studies.response.ingest.ok": "Response ingested",
  "studies.response.ingest.error": "Response ingest failed",
  "studies.response.parse.error": "Response parse failed",
  "studies.response.filter.error": "Response capture failed",
  "studies.response.capture.on_parsed_error": "Response parse hook failed",
  "studies.headers.capture.ok": "Headers captured",
  "studies.headers.capture.error": "Headers capture failed",
  "settings.auto_open.updated": "Auto-open updated",
  "settings.priority_filter.updated": "Priority filter saved",
  "priority.alert.disabled": "Priority alert disabled",
  "tab.priority_auto_open.created": "Priority study opened",
  "tab.priority_auto_open.disabled_new_tab": "Priority tab auto-open disabled",
  "tab.priority_auto_open.error": "Priority auto-open failed",
  "priority.alert.played": "Priority alert played",
  "priority.alert.error": "Priority alert failed",
  "settings.studies_refresh_policy.updated": "Cadence saved",
  "settings.studies_refresh_policy.schedule_error": "Cadence schedule failed",
  "settings.studies_refresh_policy.schedule_ok": "Cadence schedule applied",
  "service.ws.command_error": "WS command error",
  "service.ws.unknown_message_type": "WS message ignored"
});
const DEBUG_ROWS = Object.freeze([
  ["Auth", (state) => formatAuthStatus(state)],
  ["Token Sync", (state) => formatDebugTime(state.token_last_success_at)],
  ["Last Refresh", (_, refresh) => formatDebugTime(refresh.last_studies_refresh_at)],
  ["Refresh Source", (_, refresh) => refresh.last_studies_refresh_source || "n/a"],
  ["Cadence", (state) => formatCadenceSummary(state)],
  ["Last Issue", (state) => formatDebugIssue(state)],
  ["Log Entries", (state) => Number(state.debug_log_count_total) || 0]
]);
let isRefreshingView = false;
let retryCountdownTimer = null;
let retryDeadlineAt = 0;
let retryRefreshTimer = null;
let reactiveRefreshTimer = null;
let reactiveRefreshPending = false;
let latestRefreshDate = null;
let latestRefreshOffline = false;
let latestRefreshTicker = null;
let latestLiveStudies = [];
let priorityPreviewAudioContext = null;
let priorityPreviewResetTimer = null;
let priorityPreviewPlaying = false;
let priorityAlertSoundBase64PromiseByType = new Map();
let priorityAlertSoundBufferPromiseByType = new Map();
let priorityAlertSoundBufferContext = null;
let priorityFilterPersistTimer = null;
let priorityFilterPersistPending = false;
let priorityFilterPersistInFlight = false;
let currentPriorityFilter = normalizePriorityFilter({
  enabled: false,
  autoOpenInNewTab: true,
  alertSoundEnabled: true,
  alertSoundType: DEFAULT_PRIORITY_ALERT_SOUND_TYPE,
  alertSoundVolume: DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
  minimumRewardMajor: DEFAULT_PRIORITY_MIN_REWARD,
  minimumHourlyRewardMajor: DEFAULT_PRIORITY_MIN_HOURLY_REWARD,
  maximumEstimatedMinutes: DEFAULT_PRIORITY_MAX_ESTIMATED_MINUTES,
  minimumPlacesAvailable: DEFAULT_PRIORITY_MIN_PLACES,
  alwaysOpenKeywords: [],
  ignoreKeywords: []
});
let savedRefreshPolicy = normalizeRefreshPolicy(
  DEFAULT_REFRESH_MIN_DELAY_SECONDS,
  DEFAULT_REFRESH_AVERAGE_DELAY_SECONDS,
  DEFAULT_REFRESH_SPREAD_SECONDS
);

function formatRetryCountdownMessage() {
  if (!retryDeadlineAt) {
    return "Connection failed. Retrying in 5 seconds.";
  }
  const remainingMs = Math.max(0, retryDeadlineAt - Date.now());
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const label = remainingSeconds === 1 ? "second" : "seconds";
  return `Connection failed. Retrying in ${remainingSeconds} ${label}.`;
}

function renderOfflinePanels() {
  renderPanelStatusMessage(formatRetryCountdownMessage());
}

function renderAuthRequiredPanels() {
  renderPanelStatusMessage(AUTH_REQUIRED_PANEL_MESSAGE);
}

function renderPanelStatusMessage(message) {
  const safeMessage = escapeHtml(message);
  const html = `<div class="empty-events">${safeMessage}</div>`;
  liveStudiesEl.innerHTML = html;
  eventsEl.innerHTML = html;
  submissionsEl.innerHTML = html;
}

function stopRetryCountdown() {
  retryDeadlineAt = 0;
  if (retryCountdownTimer) {
    clearInterval(retryCountdownTimer);
    retryCountdownTimer = null;
  }
  if (retryRefreshTimer) {
    clearTimeout(retryRefreshTimer);
    retryRefreshTimer = null;
  }
}

function scheduleViewRefreshAfter(delayMs) {
  if (retryRefreshTimer) {
    clearTimeout(retryRefreshTimer);
  }
  retryRefreshTimer = setTimeout(() => {
    retryRefreshTimer = null;
    refreshView();
  }, delayMs);
}

function scheduleRegularRefresh() {
  scheduleViewRefreshAfter(DEFAULT_REFRESH_INTERVAL_MS);
}

function applyObservedAtUpdate(observedAt) {
  const date = parseDate(observedAt);
  if (!date) {
    return;
  }

  latestRefreshDate = date;
  latestRefreshOffline = false;
  refreshPrefixEl.textContent = "Updated ";
  latestRefreshEl.textContent = formatRelative(date.toISOString());
  latestRefreshEl.title = date.toLocaleString();
}

function scheduleReactiveRefresh() {
  reactiveRefreshPending = true;
  if (reactiveRefreshTimer || isRefreshingView) {
    return;
  }

  reactiveRefreshTimer = setTimeout(() => {
    reactiveRefreshTimer = null;
    if (!reactiveRefreshPending) {
      return;
    }
    reactiveRefreshPending = false;
    refreshView();
  }, REACTIVE_REFRESH_DEBOUNCE_MS);
}

function startOfflineRetryLoop() {
  retryDeadlineAt = Date.now() + RETRY_INTERVAL_MS;
  renderOfflinePanels();

  if (!retryCountdownTimer) {
    retryCountdownTimer = setInterval(() => {
      renderOfflinePanels();
    }, 250);
  }

  scheduleViewRefreshAfter(RETRY_INTERVAL_MS);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function calculatedCycleSecondsFromAverage(averageDelaySeconds) {
  const average = clampInt(
    averageDelaySeconds,
    MIN_REFRESH_AVERAGE_DELAY_SECONDS,
    MAX_REFRESH_AVERAGE_DELAY_SECONDS,
    DEFAULT_REFRESH_AVERAGE_DELAY_SECONDS
  );
  const countByAverage = Math.max(0, Math.floor(REFRESH_CYCLE_SECONDS / average) - 1);
  const segments = countByAverage + 1;
  return Math.max(1, Math.floor(REFRESH_CYCLE_SECONDS / segments));
}

function normalizeRefreshPolicy(minimumDelaySeconds, averageDelaySeconds, spreadSeconds) {
  const average = clampInt(
    averageDelaySeconds,
    MIN_REFRESH_AVERAGE_DELAY_SECONDS,
    MAX_REFRESH_AVERAGE_DELAY_SECONDS,
    DEFAULT_REFRESH_AVERAGE_DELAY_SECONDS
  );
  const calculatedCycleSeconds = calculatedCycleSecondsFromAverage(average);
  const maximumMinimumDelaySeconds = Math.max(
    MIN_REFRESH_MIN_DELAY_SECONDS,
    Math.min(MAX_REFRESH_MIN_DELAY_SECONDS, Math.floor(calculatedCycleSeconds / 2))
  );
  const maximumSpreadSeconds = Math.max(
    0,
    Math.min(MAX_REFRESH_SPREAD_SECONDS, Math.floor(calculatedCycleSeconds / 2))
  );

  const minimum = clampInt(
    minimumDelaySeconds,
    MIN_REFRESH_MIN_DELAY_SECONDS,
    maximumMinimumDelaySeconds,
    DEFAULT_REFRESH_MIN_DELAY_SECONDS
  );
  const spread = clampInt(
    spreadSeconds,
    0,
    maximumSpreadSeconds,
    DEFAULT_REFRESH_SPREAD_SECONDS
  );

  return {
    minimum_delay_seconds: minimum,
    average_delay_seconds: average,
    spread_seconds: spread,
    cycle_seconds: REFRESH_CYCLE_SECONDS,
    calculated_cycle_seconds: calculatedCycleSeconds,
    maximum_minimum_delay_seconds: maximumMinimumDelaySeconds,
    maximum_spread_seconds: maximumSpreadSeconds
  };
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function normalizePriorityKeywords(value) {
  const values = String(value || "").split(",");
  const unique = [];
  const seen = new Set();
  for (const item of values) {
    const keyword = item.trim().toLowerCase();
    if (!keyword || seen.has(keyword)) {
      continue;
    }
    seen.add(keyword);
    unique.push(keyword);
    if (unique.length >= MAX_PRIORITY_KEYWORDS) {
      break;
    }
  }
  return unique;
}

function canonicalPriorityAlertSoundType(value) {
  const raw = String(value || "").trim();
  if (PRIORITY_ALERT_SOUND_TYPES.has(raw)) {
    return raw;
  }
  return DEFAULT_PRIORITY_ALERT_SOUND_TYPE;
}

function normalizePriorityFilter({
  enabled,
  autoOpenInNewTab,
  alertSoundEnabled,
  alertSoundType,
  alertSoundVolume,
  minimumRewardMajor,
  minimumHourlyRewardMajor,
  maximumEstimatedMinutes,
  minimumPlacesAvailable,
  alwaysOpenKeywords,
  ignoreKeywords
}) {
  const normalizedAlertSoundType = canonicalPriorityAlertSoundType(alertSoundType);
  return {
    enabled: Boolean(enabled),
    auto_open_in_new_tab: autoOpenInNewTab !== false,
    alert_sound_enabled: alertSoundEnabled !== false,
    alert_sound_type: normalizedAlertSoundType,
    alert_sound_volume: clampInt(
      alertSoundVolume,
      MIN_PRIORITY_ALERT_SOUND_VOLUME,
      MAX_PRIORITY_ALERT_SOUND_VOLUME,
      DEFAULT_PRIORITY_ALERT_SOUND_VOLUME
    ),
    alert_sound_duration_ms: DEFAULT_PRIORITY_ALERT_SOUND_DURATION_MS,
    minimum_reward_major: Math.round(clampNumber(
      minimumRewardMajor,
      MIN_PRIORITY_MIN_REWARD,
      MAX_PRIORITY_MIN_REWARD,
      DEFAULT_PRIORITY_MIN_REWARD
    ) * 100) / 100,
    minimum_hourly_reward_major: Math.round(clampNumber(
      minimumHourlyRewardMajor,
      MIN_PRIORITY_MIN_HOURLY_REWARD,
      MAX_PRIORITY_MIN_HOURLY_REWARD,
      DEFAULT_PRIORITY_MIN_HOURLY_REWARD
    ) * 100) / 100,
    maximum_estimated_minutes: clampInt(
      maximumEstimatedMinutes,
      MIN_PRIORITY_MAX_ESTIMATED_MINUTES,
      MAX_PRIORITY_MAX_ESTIMATED_MINUTES,
      DEFAULT_PRIORITY_MAX_ESTIMATED_MINUTES
    ),
    minimum_places_available: clampInt(
      minimumPlacesAvailable,
      MIN_PRIORITY_MIN_PLACES,
      MAX_PRIORITY_MIN_PLACES,
      DEFAULT_PRIORITY_MIN_PLACES
    ),
    always_open_keywords: Array.isArray(alwaysOpenKeywords)
      ? alwaysOpenKeywords
      : normalizePriorityKeywords(alwaysOpenKeywords),
    ignore_keywords: Array.isArray(ignoreKeywords)
      ? ignoreKeywords
      : normalizePriorityKeywords(ignoreKeywords)
  };
}

function normalizePriorityFilterFromSettings(s) {
  return normalizePriorityFilter({
    enabled: s.priority_filter_enabled === true || s.auto_open_priority_studies === true,
    autoOpenInNewTab: s.priority_filter_auto_open_in_new_tab !== false,
    alertSoundEnabled: s.priority_filter_alert_sound_enabled !== false,
    alertSoundType: s.priority_filter_alert_sound_type,
    alertSoundVolume: s.priority_filter_alert_sound_volume,
    minimumRewardMajor: s.priority_filter_minimum_reward,
    minimumHourlyRewardMajor: s.priority_filter_minimum_hourly_reward,
    maximumEstimatedMinutes: s.priority_filter_maximum_estimated_minutes,
    minimumPlacesAvailable: s.priority_filter_minimum_places,
    alwaysOpenKeywords: s.priority_filter_always_open_keywords,
    ignoreKeywords: s.priority_filter_ignore_keywords
  });
}

function getPriorityPreviewAudioContext() {
  const AudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }
  if (priorityPreviewAudioContext) {
    return priorityPreviewAudioContext;
  }
  try {
    priorityPreviewAudioContext = new AudioContextCtor();
    return priorityPreviewAudioContext;
  } catch {
    return null;
  }
}

async function getPriorityAlertSoundBase64(soundType) {
  const normalized = canonicalPriorityAlertSoundType(soundType);
  if (!priorityAlertSoundBase64PromiseByType.has(normalized)) {
    const path = PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH[normalized] || PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH[DEFAULT_PRIORITY_ALERT_SOUND_TYPE];
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

function setPriorityPreviewButtonState(isPlaying) {
  if (!priorityAlertSoundPreviewButton) {
    return;
  }
  priorityAlertSoundPreviewButton.disabled = isPlaying;
  priorityAlertSoundPreviewButton.textContent = isPlaying ? "■" : "▶";
  priorityAlertSoundPreviewButton.title = isPlaying ? "Playing" : "Preview sound";
}

function queuePriorityPreviewButtonReset(durationMS) {
  if (priorityPreviewResetTimer) {
    clearTimeout(priorityPreviewResetTimer);
  }
  priorityPreviewResetTimer = setTimeout(() => {
    priorityPreviewResetTimer = null;
    priorityPreviewPlaying = false;
    setPriorityPreviewButtonState(false);
  }, Math.max(300, durationMS + 180));
}

async function playPriorityAlertPreviewFromInputs() {
  if (priorityPreviewPlaying) {
    return;
  }

  const filter = getPriorityFilterFromInputs();
  const audioContext = getPriorityPreviewAudioContext();
  if (!audioContext) {
    throw new Error("Audio preview unavailable in this browser.");
  }
  if (audioContext.state === "suspended" && typeof audioContext.resume === "function") {
    await audioContext.resume();
  }

  const soundType = canonicalPriorityAlertSoundType(filter.alert_sound_type);
  const soundVolume = clampInt(
    filter.alert_sound_volume,
    MIN_PRIORITY_ALERT_SOUND_VOLUME,
    MAX_PRIORITY_ALERT_SOUND_VOLUME,
    DEFAULT_PRIORITY_ALERT_SOUND_VOLUME
  ) / 100;
  if (soundVolume <= 0) {
    return;
  }

  const startTime = audioContext.currentTime + 0.03;
  const soundBuffer = await getPriorityAlertSoundBuffer(audioContext, soundType);
  const source = audioContext.createBufferSource();
  const gainNode = audioContext.createGain();
  source.buffer = soundBuffer;
  source.loop = false;
  gainNode.gain.setValueAtTime(Math.max(0, Math.min(2.5, Math.pow(soundVolume, 0.55) * 2.2)), startTime);
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

  priorityPreviewPlaying = true;
  setPriorityPreviewButtonState(true);
  queuePriorityPreviewButtonReset(Math.ceil((Math.max(0.1, soundBuffer.duration) + 0.12) * 1000));
  source.start(startTime);
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

function studyMatchesPriorityFilter(study, filter) {
  if (!filter || filter.enabled !== true) {
    return false;
  }

  const keywordBlob = studyKeywordBlob(study);
  if (hasAnyPriorityKeywordMatch(keywordBlob, filter.ignore_keywords)) {
    return false;
  }
  if (hasAnyPriorityKeywordMatch(keywordBlob, filter.always_open_keywords)) {
    return true;
  }

  const reward = moneyMajorValue(study && study.reward);
  if (!Number.isFinite(reward) || reward < Number(filter.minimum_reward_major)) {
    return false;
  }

  const hourly = moneyMajorValue(study && study.average_reward_per_hour);
  if (!Number.isFinite(hourly) || hourly < Number(filter.minimum_hourly_reward_major)) {
    return false;
  }

  const estimatedMinutes = Number(study && study.estimated_completion_time);
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes > Number(filter.maximum_estimated_minutes)) {
    return false;
  }

  const places = studyPlacesAvailable(study);
  if (!Number.isFinite(places) || places < Number(filter.minimum_places_available)) {
    return false;
  }

  return true;
}

function buildRefreshPlan(policy) {
  const cycle = policy.cycle_seconds;
  const minimum = policy.minimum_delay_seconds;
  const average = policy.average_delay_seconds;
  const spread = policy.spread_seconds;

  const maxCountByMinimum = Math.max(0, Math.floor(cycle / minimum) - 1);
  const maxCountByAverage = Math.max(0, Math.floor(cycle / average) - 1);
  const count = Math.max(0, Math.min(maxCountByMinimum, maxCountByAverage));

  if (count <= 0) {
    return { delays: [], windows: [], count: 0 };
  }

  const delays = [];
  const segments = count + 1;
  for (let i = 1; i <= count; i += 1) {
    delays.push((cycle * i) / segments);
  }

  const windows = delays.map((center, idx) => {
    const previous = idx === 0 ? 0 : delays[idx - 1];
    const next = idx === delays.length - 1 ? cycle : delays[idx + 1];
    const minLeft = previous + minimum;
    const maxRight = next - minimum;
    const left = Math.max(minLeft, center - spread);
    const right = Math.min(maxRight, center + spread);
    return {
      left: Math.min(left, right),
      right: Math.max(left, right)
    };
  });

  return { delays, windows, count };
}

function renderRefreshPlanPreview(policy) {
  if (!refreshPlanSummaryEl || !refreshPlanTrackEl) {
    return;
  }

  const plan = buildRefreshPlan(policy);

  const delayLabels = plan.delays.length
    ? plan.delays.map((seconds) => `${Math.round(seconds)}s`).join(", ")
    : "none within this cycle";
  refreshPlanSummaryEl.textContent =
    `Per ${policy.cycle_seconds}s cycle: ${plan.count} extra refreshes at ${delayLabels}.`;

  const markers = [
    '<span class="refresh-marker boundary" style="left:0%" title="Tab auto-refresh start"></span>',
    '<span class="refresh-marker boundary" style="left:100%" title="Next tab auto-refresh"></span>'
  ];

  const startMinRight = Math.max(0, Math.min(100, (policy.minimum_delay_seconds / policy.cycle_seconds) * 100));
  markers.push(
    `<span class="refresh-min-window" style="left:0%;width:${startMinRight}%" title="Minimum delay from cycle start"></span>`
  );

  const endMinLeft = Math.max(0, Math.min(100, ((policy.cycle_seconds - policy.minimum_delay_seconds) / policy.cycle_seconds) * 100));
  markers.push(
    `<span class="refresh-min-window" style="left:${endMinLeft}%;width:${Math.max(0, 100 - endMinLeft)}%" title="Minimum delay before next cycle"></span>`
  );

  for (const seconds of plan.delays) {
    const left = Math.max(0, Math.min(100, ((seconds - policy.minimum_delay_seconds) / policy.cycle_seconds) * 100));
    const right = Math.max(0, Math.min(100, ((seconds + policy.minimum_delay_seconds) / policy.cycle_seconds) * 100));
    const width = Math.max(0, right - left);
    markers.push(
      `<span class="refresh-min-window" style="left:${left}%;width:${width}%"></span>`
    );
  }

  for (const window of plan.windows) {
    const left = Math.max(0, Math.min(100, (window.left / policy.cycle_seconds) * 100));
    const right = Math.max(0, Math.min(100, (window.right / policy.cycle_seconds) * 100));
    const width = Math.max(0, right - left);
    markers.push(
      `<span class="refresh-window" style="left:${left}%;width:${width}%"></span>`
    );
  }

  for (const seconds of plan.delays) {
    const left = Math.max(0, Math.min(100, (seconds / policy.cycle_seconds) * 100));
    markers.push(
      `<span class="refresh-marker service" style="left:${left}%" title="Extra refresh at ~${Math.round(seconds)}s"></span>`
    );
  }

  refreshPlanTrackEl.innerHTML = `
    ${markers.join("")}
    <span class="refresh-track-label left">tab refresh</span>
    <span class="refresh-track-label right">+${policy.cycle_seconds}s</span>
  `;
}

function errorMessageFromUnknown(error) {
  if (error instanceof Error) {
    return typeof error.message === "string" ? error.message.trim() : "";
  }
  if (typeof error === "string") {
    return error.trim();
  }
  if (error == null) {
    return "";
  }
  return String(error);
}

function isNetworkFailureMessage(message) {
  const lowered = message.toLowerCase();
  return lowered.includes("failed to fetch") ||
    lowered.includes("networkerror") ||
    lowered.includes("network request failed") ||
    lowered.includes("load failed") ||
    lowered.includes("fetch resource");
}

function isServiceUnavailableError(error) {
  if (!error) {
    return false;
  }
  if (typeof error === "object" && error.code === "SERVICE_UNAVAILABLE") {
    return true;
  }
  const message = errorMessageFromUnknown(error);
  return isNetworkFailureMessage(message) || message.includes(SERVICE_OFFLINE_MESSAGE);
}

function isServiceConnectingMessage(message) {
  return String(message || "").trim() === SERVICE_CONNECTING_MESSAGE;
}

function normalizeServiceHealthMessage(message) {
  const text = String(message || "").trim();
  if (!text) {
    return "";
  }
  return text;
}

function shouldShowServiceConnectingMessage(state) {
  return !(state && state.service_ws_connected === true);
}

function toUserErrorMessage(error) {
  if (isServiceUnavailableError(error)) {
    return SERVICE_OFFLINE_MESSAGE;
  }
  return normalizeServiceHealthMessage(errorMessageFromUnknown(error)) || "Unexpected error.";
}

function parseDate(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function setHealthError(message) {
  const hasError = Boolean(message);
  syncDotEl.classList.toggle("bad", hasError);

  if (hasError) {
    errorMessageEl.textContent = message;
    errorMessageEl.style.display = "block";
    return;
  }

  errorMessageEl.textContent = "";
  errorMessageEl.style.display = "none";
}

async function getSyncState() {
  const response = await chrome.runtime.sendMessage({ action: "getState" });
  if (!response || !response.ok) {
    throw new Error("Failed to fetch extension state.");
  }
  return response.state;
}

async function sendRuntimeMessage(action, payload = {}) {
  const response = await chrome.runtime.sendMessage({ action, ...payload });
  if (!response) {
    throw new Error(`Failed to ${action}: no response from extension background.`);
  }
  if (!response.ok) {
    const detail = response.error ? ` ${response.error}` : "";
    throw new Error(`Failed to ${action}.${detail}`);
  }
  return response;
}

async function getSettings() {
  const response = await sendRuntimeMessage("getSettings");
  return response.settings || {};
}

async function setAutoOpen(enabled) {
  await sendRuntimeMessage("setAutoOpen", { enabled });
}

async function setPriorityFilter(filter) {
  const response = await sendRuntimeMessage("setPriorityFilter", filter);
  return response.settings || {};
}

async function setRefreshDelays(minimumDelaySeconds, averageDelaySeconds, spreadSeconds) {
  const response = await sendRuntimeMessage("setRefreshDelays", {
    minimum_delay_seconds: minimumDelaySeconds,
    average_delay_seconds: averageDelaySeconds,
    spread_seconds: spreadSeconds
  });
  return response.settings || {};
}

async function clearDebugLogs() {
  await sendRuntimeMessage("clearDebugLogs");
}

async function getDashboardData(liveLimit = 50, eventsLimit = 25, submissionsLimit = 100) {
  const response = await sendRuntimeMessage("getDashboardData", {
    live_limit: liveLimit,
    events_limit: eventsLimit,
    submissions_limit: submissionsLimit
  });
  return response.dashboard || {};
}

function formatShortNumber(value) {
  if (!Number.isFinite(value)) {
    return "";
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function formatMoneyFromMinorUnits(money) {
  if (!money || typeof money !== "object") {
    return "n/a";
  }

  return formatMoneyFromMajorUnits(moneyMajorValue(money), money.currency);
}

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

function formatDurationMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return "n/a";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (remaining === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remaining}m`;
}

function formatDurationSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "n/a";
  }

  const rounded = Math.round(seconds);
  if (rounded < 60) {
    return `${rounded}s`;
  }

  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes < 60) {
    if (remainingSeconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${remainingSeconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${remainingMinutes}m`;
}

function formatMoneyFromMajorUnits(amountMajor, currency) {
  const major = Number(amountMajor);
  const code = String(currency || "").toUpperCase();
  if (!Number.isFinite(major) || !code) {
    return "n/a";
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${code}`;
  }
}

function perHourBadgeClass(value) {
  const hourly = Number(value);
  if (!Number.isFinite(hourly)) {
    return "";
  }
  if (hourly > 15) {
    return " rate-ultra";
  }
  if (hourly > 10) {
    return " rate-high";
  }
  return "";
}

function normalizeSubmissionStatus(status) {
  return String(status || "")
    .trim()
    .toUpperCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function formatSubmissionStatus(status) {
  const normalized = normalizeSubmissionStatus(status);
  if (!normalized) {
    return "Unknown";
  }
  return normalized
    .split(" ")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

function submissionCardClass(status, phase) {
  const normalizedStatus = normalizeSubmissionStatus(status);
  if (normalizedStatus === "APPROVED") {
    return "event submission-approved";
  }
  if (normalizedStatus === "AWAITING REVIEW") {
    return "event submission-pending";
  }
  if (normalizedStatus === "RETURNED" || normalizedStatus === "REJECTED" || normalizedStatus === "SCREENED OUT") {
    return "event submission-negative";
  }

  const normalized = String(phase || "").toLowerCase().trim();
  if (normalized === "submitting") {
    return "event submission-active";
  }
  if (normalized === "submitted") {
    return "event submission-submitted";
  }
  return "event submission-other";
}

function extractSubmissionTimeTakenSeconds(payload) {
  if (!payload || typeof payload !== "object") {
    return NaN;
  }

  const startedAt = parseDate(payload.started_at);
  const completedAt = parseDate(payload.completed_at);
  if (!startedAt || !completedAt) {
    return NaN;
  }

  const seconds = (completedAt.getTime() - startedAt.getTime()) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : NaN;
}

function formatRelative(value, includeClock = false) {
  const date = parseDate(value);
  if (!date) {
    return "never";
  }

  const diffMs = date.getTime() - Date.now();
  const diffSeconds = Math.round(diffMs / 1000);
  const absSeconds = Math.abs(diffSeconds);

  let unit = "second";
  let count = diffSeconds;
  if (absSeconds >= 86400) {
    unit = "day";
    count = Math.round(diffSeconds / 86400);
  } else if (absSeconds >= 3600) {
    unit = "hour";
    count = Math.round(diffSeconds / 3600);
  } else if (absSeconds >= 60) {
    unit = "minute";
    count = Math.round(diffSeconds / 60);
  }

  const relative = RELATIVE_TIME_FORMATTER.format(count, unit);
  if (!includeClock) {
    return relative;
  }

  return `${relative} · ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

function studyUrlFromId(studyID) {
  const id = typeof studyID === "string" ? studyID.trim() : "";
  if (!id) {
    return "";
  }
  return `https://app.prolific.com/studies/${encodeURIComponent(id)}`;
}

function renderLiveStudies(studies) {
  if (!studies.length) {
    liveStudiesEl.innerHTML = '<div class="empty-events">No currently available studies cached yet.</div>';
    return;
  }

  const sortedStudies = [...studies].sort((a, b) => {
    const aDate = parseDate(a && (a.published_at || a.date_created));
    const bDate = parseDate(b && (b.published_at || b.date_created));
    const aTs = aDate ? aDate.getTime() : 0;
    const bTs = bDate ? bDate.getTime() : 0;
    if (aTs !== bTs) {
      return aTs - bTs;
    }

    const aId = (a && a.id ? String(a.id) : "");
    const bId = (b && b.id ? String(b.id) : "");
    return aId.localeCompare(bId);
  });

  const html = sortedStudies.map((study) => {
    const isPriority = studyMatchesPriorityFilter(study, currentPriorityFilter);
    const name = escapeHtml(study.name || "(unnamed study)");
    const reward = escapeHtml(formatMoneyFromMinorUnits(study.reward));
    const perHourMoney = study.average_reward_per_hour;
    const perHour = escapeHtml(formatMoneyFromMinorUnits(perHourMoney));
    const perHourAmount = moneyMajorValue(perHourMoney);
    const perHourClass = perHourBadgeClass(perHourAmount);
    const eta = escapeHtml(formatDurationMinutes(study.estimated_completion_time));

    const placesAvailable = Number(study.places_available);
    const placesLabel = escapeHtml(Number.isFinite(placesAvailable)
      ? `${formatShortNumber(placesAvailable)} left`
      : "n/a left");
    const placesClass = Number.isFinite(placesAvailable) && placesAvailable <= 5 ? " low" : "";

    const url = studyUrlFromId(study.id);
    const cardInner = `
      <div class="event live${isPriority ? " priority" : ""}">
        <div class="event-top">
          <div class="event-title">${name}</div>
          <div class="event-time">Live</div>
        </div>
        <div class="event-badges">
          <span class="badge">${reward}</span>
          <span class="badge${perHourClass}">${perHour}/hr</span>
          <span class="badge">${eta}</span>
          <span class="badge place${placesClass}">${placesLabel}</span>
          ${isPriority ? '<span class="badge priority">Priority</span>' : ""}
        </div>
      </div>
    `;

    if (!url) {
      return cardInner;
    }

    return `<a class="event-link live-link" href="${url}" title="Open study in Prolific">${cardInner}</a>`;
  }).join("");

  liveStudiesEl.innerHTML = html;
}

function rerenderLiveStudiesFromCache() {
  if (!Array.isArray(latestLiveStudies) || !latestLiveStudies.length) {
    return;
  }
  // Avoid replacing status placeholders like "Waiting for login."
  if (!liveStudiesEl.querySelector(".event.live")) {
    return;
  }
  renderLiveStudies(latestLiveStudies);
}

function renderEvents(events) {
  if (!events.length) {
    eventsEl.innerHTML = '<div class="empty-events">No study events yet.</div>';
    return;
  }

  const html = events.map((event) => {
    const type = event.event_type === "available" ? "available" : "unavailable";
    const name = escapeHtml(event.study_name || "(unnamed study)");
    const observedAt = escapeHtml(formatRelative(event.observed_at, true));

    const reward = escapeHtml(formatMoneyFromMinorUnits(event.reward));
    const perHourMoney = event.average_reward_per_hour;
    const perHour = escapeHtml(formatMoneyFromMinorUnits(perHourMoney));
    const perHourAmount = moneyMajorValue(perHourMoney);
    const perHourClass = perHourBadgeClass(perHourAmount);
    const duration = escapeHtml(formatDurationMinutes(event.estimated_completion_time));

    const totalPlaces = Number(event.total_available_places);
    const remainingPlaces = Number(event.places_available);
    const isLowRemaining = type === "available" && Number.isFinite(remainingPlaces) && remainingPlaces <= 5;
    const placesLine = escapeHtml(type === "available"
      ? `${Number.isFinite(remainingPlaces) ? formatShortNumber(remainingPlaces) : "n/a"} left`
      : `${Number.isFinite(totalPlaces) ? formatShortNumber(totalPlaces) : "n/a"} total`);
    const placesClass = isLowRemaining ? " low" : "";
    const studyURL = studyUrlFromId(event.study_id);
    const cardInner = `
      <div class="event ${type}">
        <div class="event-top">
          <div class="event-title">${name}</div>
          <div class="event-time">${observedAt}</div>
        </div>
        <div class="event-badges">
          <span class="badge">${reward}</span>
          <span class="badge${perHourClass}">${perHour}/hr</span>
          <span class="badge">${duration}</span>
          <span class="badge place${placesClass}">${placesLine}</span>
        </div>
      </div>
    `;

    if (!studyURL) {
      return cardInner;
    }

    return `
      <a class="event-link" href="${studyURL}" title="Open study in Prolific">
        ${cardInner}
      </a>
    `;
  }).join("");

  eventsEl.innerHTML = html;
}

function renderSubmissions(submissions) {
  if (!Array.isArray(submissions) || !submissions.length) {
    submissionsEl.innerHTML = '<div class="empty-events">No submissions tracked yet.</div>';
    return;
  }

  const sorted = [...submissions].sort((a, b) => {
    const aDate = parseDate(a && a.observed_at);
    const bDate = parseDate(b && b.observed_at);
    const aTs = aDate ? aDate.getTime() : 0;
    const bTs = bDate ? bDate.getTime() : 0;
    if (aTs !== bTs) {
      return bTs - aTs;
    }
    const aID = a && a.submission_id ? String(a.submission_id) : "";
    const bID = b && b.submission_id ? String(b.submission_id) : "";
    return bID.localeCompare(aID);
  });

  const html = sorted.map((entry) => {
    const name = escapeHtml(entry.study_name || "(unknown study)");
    const observedAt = escapeHtml(formatRelative(entry.observed_at, true));
    const studyURL = studyUrlFromId(entry.study_id);

    const payload = entry && entry.payload && typeof entry.payload === "object"
      ? entry.payload
      : {};
    const rewardMoney = payload && payload.submission_reward && typeof payload.submission_reward === "object"
      ? payload.submission_reward
      : null;
    const reward = escapeHtml(formatMoneyFromMinorUnits(rewardMoney));

    const timeTakenSeconds = extractSubmissionTimeTakenSeconds(payload);
    const duration = escapeHtml(formatDurationSeconds(timeTakenSeconds));

    const rewardMajor = moneyMajorValue(rewardMoney);
    const hourlyMajor = Number.isFinite(rewardMajor) && Number.isFinite(timeTakenSeconds) && timeTakenSeconds > 0
      ? (rewardMajor * 3600) / timeTakenSeconds
      : NaN;
    const hourlyLabel = formatMoneyFromMajorUnits(hourlyMajor, rewardMoney && rewardMoney.currency);
    const hourly = escapeHtml(hourlyLabel === "n/a" ? "n/a" : `${hourlyLabel}/hr`);
    const perHourClass = perHourBadgeClass(hourlyMajor);
    const cardClass = submissionCardClass(entry.status, entry.phase);
    const statusLabel = escapeHtml(formatSubmissionStatus(entry.status));

    const cardInner = `
      <div class="${cardClass}">
        <div class="event-top">
          <div class="event-title">${name}</div>
          <div class="event-time">${observedAt}</div>
        </div>
        <div class="event-badges">
          <span class="badge">${statusLabel}</span>
          <span class="badge">${reward}</span>
          <span class="badge${perHourClass}">${hourly}</span>
          <span class="badge">${duration}</span>
        </div>
      </div>
    `;

    if (!studyURL) {
      return cardInner;
    }
    return `<a class="event-link" href="${studyURL}" title="Open study in Prolific">${cardInner}</a>`;
  }).join("");

  submissionsEl.innerHTML = html;
}

function activateTab(tabName) {
  panelLive.classList.toggle("active", tabName === "live");
  panelSubmissions.classList.toggle("active", tabName === "submissions");
  panelFeed.classList.toggle("active", tabName === "feed");
  panelSettings.classList.toggle("active", tabName === "settings");

  for (const button of tabButtons) {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function deriveErrorMessage(state, sourceError) {
  if (sourceError) {
    return normalizeServiceHealthMessage(sourceError);
  }
  if (!state) {
    return "";
  }
  if (state.token_ok === false) {
    return normalizeServiceHealthMessage(state.token_reason || "Token sync error.");
  }
  if (state.studies_headers_ok === false) {
    return normalizeServiceHealthMessage(state.studies_headers_reason || "Studies header capture error.");
  }
  if (state.studies_refresh_ok === false) {
    return normalizeServiceHealthMessage(state.studies_refresh_reason || "Studies refresh sync error.");
  }
  if (
    state.studies_response_capture_supported === true &&
    state.studies_response_capture_ok === false &&
    state.studies_response_capture_reason
  ) {
    if (isServiceConnectingMessage(state.studies_response_capture_reason) && !shouldShowServiceConnectingMessage(state)) {
      return "";
    }
    return normalizeServiceHealthMessage(state.studies_response_capture_reason);
  }
  return "";
}

function isAuthRequiredState(state) {
  if (!state || typeof state !== "object") {
    return false;
  }
  if (state.token_auth_required === true) {
    return true;
  }
  if (state.token_ok !== false) {
    return false;
  }
  const reason = String(state.token_reason || "").toLowerCase();
  return reason.includes("no valid oidc.user token payload") ||
    reason.includes("signed out of prolific");
}

function renderLatestRefresh(serviceRefreshState) {
  const latest = parseDate(serviceRefreshState && serviceRefreshState.last_studies_refresh_at);
  if (!latest) {
    latestRefreshDate = null;
    latestRefreshOffline = false;
    refreshPrefixEl.textContent = "Updated ";
    latestRefreshEl.textContent = "never";
    latestRefreshEl.removeAttribute("title");
    return;
  }

  latestRefreshDate = latest;
  latestRefreshOffline = false;
  refreshPrefixEl.textContent = "Updated ";
  latestRefreshEl.textContent = formatRelative(latestRefreshDate.toISOString());
  latestRefreshEl.title = latestRefreshDate.toLocaleString();
}

function renderOfflineLatestRefresh() {
  latestRefreshOffline = true;
  refreshPrefixEl.textContent = "";
  latestRefreshEl.textContent = "Offline";
  latestRefreshEl.title = "Local service unavailable";
}

function renderSignedOutLatestRefresh() {
  latestRefreshOffline = false;
  latestRefreshDate = null;
  refreshPrefixEl.textContent = "";
  latestRefreshEl.textContent = "Signed out";
  latestRefreshEl.title = AUTH_REQUIRED_MESSAGE;
}

function tickLatestRefreshLabel() {
  if (latestRefreshOffline) {
    renderOfflineLatestRefresh();
    return;
  }
  if (!latestRefreshDate) {
    return;
  }

  refreshPrefixEl.textContent = "Updated ";
  latestRefreshEl.textContent = formatRelative(latestRefreshDate.toISOString());
  latestRefreshEl.title = latestRefreshDate.toLocaleString();
}

function formatDebugTime(value) {
  if (!parseDate(value)) {
    return "never";
  }
  return formatRelative(value);
}

function formatAuthStatus(state) {
  if (!state || typeof state !== "object") {
    return "n/a";
  }
  if (isAuthRequiredState(state)) {
    return "signed out";
  }
  if (state.token_ok === true) {
    return "connected";
  }
  if (state.token_ok === false) {
    return "degraded";
  }
  return "n/a";
}

function formatCadenceSummary(state) {
  if (!state || typeof state !== "object") {
    return "n/a";
  }
  const minDelay = Number(state.studies_refresh_min_delay_seconds);
  const avgDelay = Number(state.studies_refresh_average_delay_seconds);
  const spread = Number(state.studies_refresh_spread_seconds);
  if (!Number.isFinite(minDelay) || !Number.isFinite(avgDelay) || !Number.isFinite(spread)) {
    return "n/a";
  }
  return `min ${minDelay}s · avg ${avgDelay}s · spread ${spread}s`;
}

function formatDebugIssue(state) {
  if (!state || typeof state !== "object") {
    return "none";
  }
  if (isAuthRequiredState(state)) {
    return "waiting for login";
  }
  if (state.token_ok === false) {
    return compactText(normalizeServiceHealthMessage(state.token_reason || "token sync failed"));
  }
  if (state.studies_headers_ok === false) {
    return compactText(normalizeServiceHealthMessage(state.studies_headers_reason || "headers capture failed"));
  }
  if (state.studies_refresh_ok === false) {
    return compactText(normalizeServiceHealthMessage(state.studies_refresh_reason || "refresh sync failed"));
  }
  if (state.studies_response_capture_ok === false) {
    if (isServiceConnectingMessage(state.studies_response_capture_reason) && !shouldShowServiceConnectingMessage(state)) {
      return "none";
    }
    return compactText(normalizeServiceHealthMessage(state.studies_response_capture_reason || "response capture failed"));
  }
  return "none";
}

function formatDebugLogEvent(eventName) {
  if (DEBUG_EVENT_LABELS[eventName]) {
    return DEBUG_EVENT_LABELS[eventName];
  }
  return eventName || "unknown";
}

function formatDebugLogDetails(entry) {
  const details = entry && entry.details && typeof entry.details === "object"
    ? entry.details
    : null;
  if (!details) {
    return "";
  }
  if (details.error) {
    return ` · ${compactText(String(details.error), 96)}`;
  }
  if (typeof details.status_code === "number") {
    return ` · HTTP ${details.status_code}`;
  }
  if (details.trigger) {
    return ` · ${String(details.trigger)}`;
  }
  if (details.reason) {
    return ` · ${compactText(String(details.reason), 96)}`;
  }
  return "";
}

function compactText(value, maxLength = 72) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function renderDebugInfo(extensionState, serviceRefreshState) {
  const state = extensionState || {};
  const refresh = serviceRefreshState || {};

  const rows = DEBUG_ROWS.map(([label, read]) => [label, read(state, refresh)]);

  debugGridEl.innerHTML = rows.map(([key, value]) => `
    <div class="debug-row">
      <span class="debug-key">${escapeHtml(key)}</span>
      <span class="debug-value">${escapeHtml(String(value))}</span>
    </div>
  `).join("");

  const logs = Array.isArray(state.debug_logs) ? state.debug_logs : [];
  if (!logs.length) {
    debugLogEl.innerHTML = '<div class="debug-line">No diagnostic events yet.</div>';
    return;
  }

  debugLogEl.innerHTML = logs.slice(0, 30).map((entry) => {
    const at = formatRelative(entry && entry.at, true);
    const eventName = entry && entry.event ? String(entry.event) : "unknown";
    const label = formatDebugLogEvent(eventName);
    const details = formatDebugLogDetails(entry);
    const repeatCount = Math.max(1, Number(entry && entry.repeat_count) || 1);
    const repeatLabel = repeatCount > 1 ? ` (x${repeatCount})` : "";
    return `<div class="debug-line">${escapeHtml(at)}  ${escapeHtml(label)}${escapeHtml(repeatLabel + details)}</div>`;
  }).join("");
}

async function runWithHealthError(task) {
  try {
    await task();
  } catch (error) {
    setHealthError(error.message);
  }
}

async function refreshSettings() {
  try {
    const settings = await getSettings();
    autoOpenToggle.checked = settings.auto_open_prolific_tab !== false;
    const priorityFilter = normalizePriorityFilterFromSettings(settings);
    applyPriorityFilterToControls(priorityFilter);
    const refreshPolicy = normalizeRefreshPolicy(
      settings.studies_refresh_min_delay_seconds,
      settings.studies_refresh_average_delay_seconds,
      settings.studies_refresh_spread_seconds
    );
    savedRefreshPolicy = refreshPolicy;
    applyRefreshPolicyToControls(refreshPolicy);
  } catch (error) {
    setHealthError(error.message);
  }
}

function dashboardSectionOrError(section, fallbackError) {
  if (section && section.ok === true) {
    return { ok: true, data: section.data };
  }
  if (section && section.ok === false) {
    return { ok: false, error: section.error || fallbackError };
  }
  return { ok: false, error: fallbackError };
}

async function refreshView() {
  if (isRefreshingView) {
    reactiveRefreshPending = true;
    return;
  }
  isRefreshingView = true;
  reactiveRefreshPending = false;

  try {
    const [stateResult, dashboardResult] = await Promise.allSettled([
      getSyncState(),
      getDashboardData(50, 25, 100)
    ]);

    const extensionState = stateResult.status === "fulfilled" ? stateResult.value : null;
    const authRequired = isAuthRequiredState(extensionState);

    const dashboard = dashboardResult.status === "fulfilled" ? dashboardResult.value : null;
    const dashboardError = dashboardResult.status === "rejected"
      ? toUserErrorMessage(dashboardResult.reason)
      : "Failed to fetch dashboard data.";

    const refreshSection = dashboardSectionOrError(
      dashboard && dashboard.refresh_state,
      dashboardError
    );
    const studiesSection = dashboardSectionOrError(
      dashboard && dashboard.studies,
      dashboardError
    );
    const eventsSection = dashboardSectionOrError(
      dashboard && dashboard.events,
      dashboardError
    );
    const submissionsSection = dashboardSectionOrError(
      dashboard && dashboard.submissions,
      dashboardError
    );
    const refreshState = refreshSection.ok ? refreshSection.data : null;

    const serviceSections = [refreshSection, studiesSection, eventsSection, submissionsSection];
    const serviceSuccessCount = serviceSections.filter((section) => section.ok).length;
    const serviceUnavailableCount = serviceSections.filter(
      (section) => !section.ok && isServiceUnavailableError(section.error)
    ).length;
    const serviceOffline = serviceSuccessCount === 0 && serviceUnavailableCount === serviceSections.length;

    if (serviceOffline) {
      startOfflineRetryLoop();
    } else {
      stopRetryCountdown();
      scheduleRegularRefresh();

      if (authRequired) {
        renderAuthRequiredPanels();
      } else {
        if (studiesSection.ok) {
          latestLiveStudies = Array.isArray(studiesSection.data) ? studiesSection.data : [];
          renderLiveStudies(latestLiveStudies);
        } else {
          latestLiveStudies = [];
          liveStudiesEl.innerHTML = `<div class="empty-events">${escapeHtml(toUserErrorMessage(studiesSection.error))}</div>`;
        }

        if (eventsSection.ok) {
          renderEvents(eventsSection.data);
        } else {
          eventsEl.innerHTML = `<div class="empty-events">${escapeHtml(toUserErrorMessage(eventsSection.error))}</div>`;
        }

        if (submissionsSection.ok) {
          renderSubmissions(submissionsSection.data);
        } else {
          submissionsEl.innerHTML = `<div class="empty-events">${escapeHtml(toUserErrorMessage(submissionsSection.error))}</div>`;
        }
      }
    }

    let firstErrorMessage = "";
    if (serviceOffline) {
      firstErrorMessage = SERVICE_OFFLINE_MESSAGE;
    } else if (stateResult.status === "rejected") {
      firstErrorMessage = toUserErrorMessage(stateResult.reason);
    } else {
      const firstServiceError = serviceSections.find(
        (section) => !section.ok && !isServiceUnavailableError(section.error)
      );
      if (firstServiceError) {
        firstErrorMessage = toUserErrorMessage(firstServiceError.error);
      }
    }

    let healthMessage = deriveErrorMessage(extensionState, firstErrorMessage);
    if (authRequired) {
      healthMessage = AUTH_REQUIRED_MESSAGE;
    }
    if (!serviceOffline && serviceSuccessCount > 0 && isServiceUnavailableError(healthMessage)) {
      healthMessage = "";
    }

    if (serviceOffline || isServiceConnectingMessage(healthMessage)) {
      renderOfflineLatestRefresh();
    } else if (authRequired) {
      renderSignedOutLatestRefresh();
    } else {
      renderLatestRefresh(refreshState);
    }
    renderDebugInfo(extensionState, refreshState);
    setHealthError(healthMessage);
  } finally {
    isRefreshingView = false;
    if (reactiveRefreshPending && !reactiveRefreshTimer) {
      scheduleReactiveRefresh();
    }
  }
}

function getRefreshPolicyFromInputs() {
  return normalizeRefreshPolicy(
    refreshMinDelayInput ? refreshMinDelayInput.value : undefined,
    refreshAverageDelayInput ? refreshAverageDelayInput.value : undefined,
    refreshSpreadInput ? refreshSpreadInput.value : undefined
  );
}

function areRefreshPoliciesEquivalent(left, right) {
  if (!left || !right) {
    return false;
  }
  return left.minimum_delay_seconds === right.minimum_delay_seconds &&
    left.average_delay_seconds === right.average_delay_seconds &&
    left.spread_seconds === right.spread_seconds;
}

function updateRefreshCadenceActions() {
  if (!refreshCadenceActionsEl) {
    return;
  }
  const current = getRefreshPolicyFromInputs();
  const hasUnsavedChanges = !areRefreshPoliciesEquivalent(current, savedRefreshPolicy);
  refreshCadenceActionsEl.classList.toggle("visible", hasUnsavedChanges);
}

function getPriorityFilterFromInputs() {
  return normalizePriorityFilter({
    enabled: priorityFilterEnabledToggle ? priorityFilterEnabledToggle.checked : false,
    autoOpenInNewTab: priorityAutoOpenInNewTabToggle ? priorityAutoOpenInNewTabToggle.checked : true,
    alertSoundEnabled: priorityAlertSoundToggle ? priorityAlertSoundToggle.checked : true,
    alertSoundType: priorityAlertSoundTypeSelect ? priorityAlertSoundTypeSelect.value : currentPriorityFilter.alert_sound_type,
    alertSoundVolume: priorityAlertSoundVolumeInput ? priorityAlertSoundVolumeInput.value : currentPriorityFilter.alert_sound_volume,
    minimumRewardMajor: priorityMinRewardInput ? priorityMinRewardInput.value : undefined,
    minimumHourlyRewardMajor: priorityMinHourlyInput ? priorityMinHourlyInput.value : undefined,
    maximumEstimatedMinutes: priorityMaxEtaInput ? priorityMaxEtaInput.value : undefined,
    minimumPlacesAvailable: priorityMinPlacesInput ? priorityMinPlacesInput.value : undefined,
    alwaysOpenKeywords: priorityAlwaysKeywordsInput ? priorityAlwaysKeywordsInput.value : "",
    ignoreKeywords: priorityIgnoreKeywordsInput ? priorityIgnoreKeywordsInput.value : ""
  });
}

async function persistPriorityFilterIfNeeded() {
  if (priorityFilterPersistInFlight) {
    return;
  }
  priorityFilterPersistInFlight = true;
  try {
    while (priorityFilterPersistPending) {
      priorityFilterPersistPending = false;
      await runWithHealthError(() => persistPriorityFilterFromInputs());
    }
  } finally {
    priorityFilterPersistInFlight = false;
  }
}

function schedulePriorityFilterPersist() {
  priorityFilterPersistPending = true;
  if (priorityFilterPersistTimer) {
    clearTimeout(priorityFilterPersistTimer);
  }
  priorityFilterPersistTimer = setTimeout(() => {
    priorityFilterPersistTimer = null;
    void persistPriorityFilterIfNeeded();
  }, PRIORITY_FILTER_PERSIST_DEBOUNCE_MS);
}

async function persistPriorityFilterFromInputs() {
  const filter = getPriorityFilterFromInputs();
  applyPriorityFilterToControls(filter);
  const saved = await setPriorityFilter(filter);
  const normalized = normalizePriorityFilterFromSettings(saved);
  applyPriorityFilterToControls(normalized);
}

function applyPriorityFilterToControls(filter) {
  if (!filter || typeof filter !== "object") {
    return;
  }
  currentPriorityFilter = filter;
  rerenderLiveStudiesFromCache();
  if (priorityFilterEnabledToggle) {
    priorityFilterEnabledToggle.checked = filter.enabled === true;
  }
  if (priorityAutoOpenInNewTabToggle) {
    priorityAutoOpenInNewTabToggle.checked = filter.auto_open_in_new_tab !== false;
  }
  if (priorityAlertSoundToggle) {
    priorityAlertSoundToggle.checked = filter.alert_sound_enabled !== false;
  }
  if (priorityAlertSoundTypeSelect) {
    priorityAlertSoundTypeSelect.value = filter.alert_sound_type;
  }
  if (priorityAlertSoundVolumeInput) {
    priorityAlertSoundVolumeInput.value = String(filter.alert_sound_volume);
  }
  if (priorityMinRewardInput) {
    priorityMinRewardInput.value = String(filter.minimum_reward_major);
  }
  if (priorityMinHourlyInput) {
    priorityMinHourlyInput.value = String(filter.minimum_hourly_reward_major);
  }
  if (priorityMaxEtaInput) {
    priorityMaxEtaInput.value = String(filter.maximum_estimated_minutes);
  }
  if (priorityMinPlacesInput) {
    priorityMinPlacesInput.value = String(filter.minimum_places_available);
  }
  if (priorityAlwaysKeywordsInput) {
    priorityAlwaysKeywordsInput.value = (Array.isArray(filter.always_open_keywords) ? filter.always_open_keywords : []).join(", ");
  }
  if (priorityIgnoreKeywordsInput) {
    priorityIgnoreKeywordsInput.value = (Array.isArray(filter.ignore_keywords) ? filter.ignore_keywords : []).join(", ");
  }
  if (priorityAlertSoundConfig) {
    priorityAlertSoundConfig.classList.toggle("active", Boolean(filter && filter.alert_sound_enabled !== false));
  }
}

function applyRefreshPolicyToControls(refreshPolicy) {
  if (!refreshPolicy || typeof refreshPolicy !== "object") {
    return;
  }
  if (refreshMinDelayInput) {
    refreshMinDelayInput.max = String(refreshPolicy.maximum_minimum_delay_seconds);
    refreshMinDelayInput.value = String(refreshPolicy.minimum_delay_seconds);
  }
  if (refreshAverageDelayInput) {
    refreshAverageDelayInput.value = String(refreshPolicy.average_delay_seconds);
  }
  if (refreshSpreadInput) {
    refreshSpreadInput.max = String(refreshPolicy.maximum_spread_seconds);
    refreshSpreadInput.value = String(refreshPolicy.spread_seconds);
  }
  if (refreshMinDelayValueEl) {
    refreshMinDelayValueEl.textContent = `${refreshPolicy.minimum_delay_seconds}s`;
  }
  if (refreshAverageDelayValueEl) {
    refreshAverageDelayValueEl.textContent = `${refreshPolicy.average_delay_seconds}s`;
  }
  if (refreshSpreadValueEl) {
    refreshSpreadValueEl.textContent = `${refreshPolicy.spread_seconds}s`;
  }
  renderRefreshPlanPreview(refreshPolicy);
  updateRefreshCadenceActions();
}

autoOpenToggle.addEventListener("change", async (event) => {
  try {
    await setAutoOpen(Boolean(event.target.checked));
    await refreshView();
  } catch (error) {
    setHealthError(error.message);
    await refreshSettings();
  }
});

const priorityFilterControls = [
  priorityFilterEnabledToggle,
  priorityAutoOpenInNewTabToggle,
  priorityAlertSoundToggle,
  priorityAlertSoundTypeSelect,
  priorityAlertSoundVolumeInput,
  priorityMinRewardInput,
  priorityMinHourlyInput,
  priorityMaxEtaInput,
  priorityMinPlacesInput,
  priorityAlwaysKeywordsInput,
  priorityIgnoreKeywordsInput
];

for (const control of priorityFilterControls) {
  if (!control) {
    continue;
  }
  control.addEventListener("input", schedulePriorityFilterPersist);
  control.addEventListener("change", schedulePriorityFilterPersist);
}

if (priorityAlertSoundPreviewButton) {
  priorityAlertSoundPreviewButton.addEventListener("click", async () => {
    await runWithHealthError(async () => {
      await playPriorityAlertPreviewFromInputs();
    });
  });
}

if (refreshMinDelayInput && refreshAverageDelayInput && refreshSpreadInput) {
  const updatePreview = () => {
    const refreshPolicy = getRefreshPolicyFromInputs();
    applyRefreshPolicyToControls(refreshPolicy);
  };

  refreshMinDelayInput.addEventListener("input", updatePreview);
  refreshAverageDelayInput.addEventListener("input", updatePreview);
  refreshSpreadInput.addEventListener("input", updatePreview);
}

if (refreshCadenceSaveButton) {
  refreshCadenceSaveButton.addEventListener("click", async () => {
    const refreshPolicy = getRefreshPolicyFromInputs();
    applyRefreshPolicyToControls(refreshPolicy);

    await runWithHealthError(async () => {
      const saved = await setRefreshDelays(
        refreshPolicy.minimum_delay_seconds,
        refreshPolicy.average_delay_seconds,
        refreshPolicy.spread_seconds
      );
      const normalized = normalizeRefreshPolicy(
        saved.studies_refresh_min_delay_seconds,
        saved.studies_refresh_average_delay_seconds,
        saved.studies_refresh_spread_seconds
      );
      savedRefreshPolicy = normalized;
      applyRefreshPolicyToControls(normalized);
    });
  });
}

if (refreshCadenceRevertButton) {
  refreshCadenceRevertButton.addEventListener("click", () => {
    applyRefreshPolicyToControls(savedRefreshPolicy);
  });
}

for (const button of tabButtons) {
  button.addEventListener("click", () => {
    activateTab(button.dataset.tab || "feed");
  });
}

if (refreshDebugButton) {
  refreshDebugButton.addEventListener("click", async () => {
    await refreshView();
  });
}

if (clearDebugButton) {
  clearDebugButton.addEventListener("click", async () => {
    await runWithHealthError(async () => {
      await clearDebugLogs();
      await refreshView();
    });
  });
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  const link = target.closest("a.event-link");
  if (!link) {
    return;
  }
  event.preventDefault();

  const href = link.getAttribute("href");
  if (!href) {
    return;
  }

  chrome.tabs.create({ url: href, active: true }, () => {
    setTimeout(() => window.close(), 0);
  });
});

if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.action !== "dashboardUpdated") {
      return false;
    }

    applyObservedAtUpdate(message.observed_at);
    scheduleReactiveRefresh();
    return false;
  });
}

refreshSettings();
activateTab("live");
refreshView();
latestRefreshTicker = setInterval(tickLatestRefreshLabel, 1000);
