const autoOpenToggle = document.getElementById("autoOpenToggle");
const syncDotEl = document.getElementById("syncDot");
const refreshPrefixEl = document.getElementById("refreshPrefix");
const latestRefreshEl = document.getElementById("latestRefresh");
const errorMessageEl = document.getElementById("errorMessage");
const liveStudiesEl = document.getElementById("liveStudies");
const eventsEl = document.getElementById("events");
const refreshDebugButton = document.getElementById("refreshDebugButton");
const clearDebugButton = document.getElementById("clearDebugButton");
const debugGridEl = document.getElementById("debugGrid");
const debugLogEl = document.getElementById("debugLog");
const tabButtons = Array.from(document.querySelectorAll(".tab"));
const panelLive = document.getElementById("panelLive");
const panelFeed = document.getElementById("panelFeed");
const panelSettings = document.getElementById("panelSettings");
const refreshMinDelayInput = document.getElementById("refreshMinDelayInput");
const refreshAverageDelayInput = document.getElementById("refreshAverageDelayInput");
const refreshSpreadInput = document.getElementById("refreshSpreadInput");
const refreshMinDelayValueEl = document.getElementById("refreshMinDelayValue");
const refreshAverageDelayValueEl = document.getElementById("refreshAverageDelayValue");
const refreshSpreadValueEl = document.getElementById("refreshSpreadValue");
const refreshCadenceSaveButton = document.getElementById("refreshCadenceSaveButton");
const refreshPlanSummaryEl = document.getElementById("refreshPlanSummary");
const refreshPlanTrackEl = document.getElementById("refreshPlanTrack");

const SERVICE_BASE_URL = "http://localhost:8080";
const SERVICE_OFFLINE_MESSAGE = "Local service offline, start the Go server to continue.";
const AUTH_REQUIRED_MESSAGE = "Signed out of Prolific. Log in at app.prolific.com to resume syncing.";
const AUTH_REQUIRED_PANEL_MESSAGE = "Waiting for login.";
const RETRY_INTERVAL_MS = 5000;
const DEFAULT_REFRESH_INTERVAL_MS = 20000;
const REFRESH_CYCLE_SECONDS = 120;
const DEFAULT_REFRESH_MIN_DELAY_SECONDS = 20;
const DEFAULT_REFRESH_AVERAGE_DELAY_SECONDS = 30;
const DEFAULT_REFRESH_SPREAD_SECONDS = 0;
const MIN_REFRESH_MIN_DELAY_SECONDS = 1;
const MIN_REFRESH_AVERAGE_DELAY_SECONDS = 5;
const MAX_REFRESH_MIN_DELAY_SECONDS = 60;
const MAX_REFRESH_AVERAGE_DELAY_SECONDS = 60;
const MAX_REFRESH_SPREAD_SECONDS = 60;
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
  "studies.headers.capture.ok": "Headers captured",
  "studies.headers.capture.error": "Headers capture failed",
  "settings.auto_open.updated": "Auto-open updated",
  "settings.studies_refresh_policy.updated": "Cadence saved",
  "settings.studies_refresh_policy.schedule_error": "Cadence schedule failed",
  "settings.studies_refresh_policy.schedule_ok": "Cadence schedule applied"
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

let stream = null;
let streamRefreshTimer = null;
let isRefreshingView = false;
let retryCountdownTimer = null;
let retryDeadlineAt = 0;
let retryRefreshTimer = null;
let latestRefreshDate = null;
let latestRefreshOffline = false;
let latestRefreshTicker = null;

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

function scheduleRegularRefresh() {
  if (retryRefreshTimer) {
    clearTimeout(retryRefreshTimer);
  }
  retryRefreshTimer = setTimeout(() => {
    retryRefreshTimer = null;
    refreshView();
  }, DEFAULT_REFRESH_INTERVAL_MS);
}

function startOfflineRetryLoop() {
  if (retryRefreshTimer) {
    clearTimeout(retryRefreshTimer);
    retryRefreshTimer = null;
  }

  retryDeadlineAt = Date.now() + RETRY_INTERVAL_MS;
  renderOfflinePanels();

  if (!retryCountdownTimer) {
    retryCountdownTimer = setInterval(() => {
      renderOfflinePanels();
    }, 250);
  }

  retryRefreshTimer = setTimeout(() => {
    retryRefreshTimer = null;
    refreshView();
  }, RETRY_INTERVAL_MS);
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

function createServiceUnavailableError(contextLabel) {
  const prefix = contextLabel ? `${contextLabel}: ` : "";
  const error = new Error(`${prefix}${SERVICE_OFFLINE_MESSAGE}`);
  error.code = "SERVICE_UNAVAILABLE";
  return error;
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

function toUserErrorMessage(error) {
  if (isServiceUnavailableError(error)) {
    return SERVICE_OFFLINE_MESSAGE;
  }
  return errorMessageFromUnknown(error) || "Unexpected error.";
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

async function fetchServiceJSON(path, options, contextLabel) {
  let response;
  try {
    response = await fetch(`${SERVICE_BASE_URL}${path}`, options);
  } catch (error) {
    const message = errorMessageFromUnknown(error);
    if (error instanceof TypeError || isNetworkFailureMessage(message)) {
      throw createServiceUnavailableError(contextLabel);
    }
    throw new Error(`${contextLabel}: ${message || "Unknown network error."}`);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${contextLabel}: HTTP ${response.status}${text ? ` ${text}` : ""}`);
  }
  return response.json();
}

async function getSettings() {
  const response = await sendRuntimeMessage("getSettings");
  return response.settings || {};
}

async function setAutoOpen(enabled) {
  await sendRuntimeMessage("setAutoOpen", { enabled });
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

async function getLiveStudies(limit = 50) {
  const payload = await fetchServiceJSON(`/studies-live?limit=${limit}`, undefined, "Failed to fetch live studies");
  return Array.isArray(payload.results) ? payload.results : [];
}

async function getLatestEvents(limit = 25) {
  const payload = await fetchServiceJSON(`/study-events?limit=${limit}`, undefined, "Failed to fetch study events");
  return Array.isArray(payload.events) ? payload.events : [];
}

async function getServiceRefreshState() {
  return fetchServiceJSON("/studies-refresh", undefined, "Failed to fetch refresh state");
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

  const rawAmount = Number(money.amount);
  if (!Number.isFinite(rawAmount)) {
    return "n/a";
  }

  const currency = (money.currency || "").toUpperCase();
  if (!currency) {
    return "n/a";
  }

  const majorAmount = rawAmount / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(majorAmount);
  } catch {
    return `${majorAmount.toFixed(2)} ${currency}`;
  }
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
    const name = escapeHtml(study.name || "(unnamed study)");
    const reward = escapeHtml(formatMoneyFromMinorUnits(study.reward));
    const perHourMoney = study.average_reward_per_hour;
    const perHour = escapeHtml(formatMoneyFromMinorUnits(perHourMoney));
    const perHourAmount = moneyMajorValue(perHourMoney);
    const perHourClass = perHourAmount > 15 ? " rate-ultra" : (perHourAmount > 10 ? " rate-high" : "");
    const eta = escapeHtml(formatDurationMinutes(study.estimated_completion_time));

    const placesAvailable = Number(study.places_available);
    const placesLabel = escapeHtml(Number.isFinite(placesAvailable)
      ? `${formatShortNumber(placesAvailable)} left`
      : "n/a left");
    const placesClass = Number.isFinite(placesAvailable) && placesAvailable <= 5 ? " low" : "";

    const url = studyUrlFromId(study.id);
    const cardInner = `
      <div class="event live">
        <div class="event-top">
          <div class="event-title">${name}</div>
          <div class="event-time">Live</div>
        </div>
        <div class="event-badges">
          <span class="badge">${reward}</span>
          <span class="badge${perHourClass}">${perHour}/hr</span>
          <span class="badge">${eta}</span>
          <span class="badge place${placesClass}">${placesLabel}</span>
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
    const perHourClass = perHourAmount > 15 ? " rate-ultra" : (perHourAmount > 10 ? " rate-high" : "");
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

function activateTab(tabName) {
  panelLive.classList.toggle("active", tabName === "live");
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
    return sourceError;
  }
  if (!state) {
    return "";
  }
  if (state.token_ok === false) {
    return state.token_reason || "Token sync error.";
  }
  if (state.studies_headers_ok === false) {
    return state.studies_headers_reason || "Studies header capture error.";
  }
  if (state.studies_refresh_ok === false) {
    return state.studies_refresh_reason || "Studies refresh sync error.";
  }
  if (
    state.studies_response_capture_supported === true &&
    state.studies_response_capture_ok === false &&
    state.studies_response_capture_reason
  ) {
    return state.studies_response_capture_reason;
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

function renderLatestRefresh(serviceRefreshState, extensionState) {
  const candidates = [];

  const extDate = parseDate(extensionState && extensionState.studies_last_refresh_at);
  if (extDate) {
    candidates.push(extDate);
  }

  const svcDate = parseDate(serviceRefreshState && serviceRefreshState.last_studies_refresh_at);
  if (svcDate) {
    candidates.push(svcDate);
  }

  if (!candidates.length) {
    latestRefreshDate = null;
    latestRefreshOffline = false;
    refreshPrefixEl.textContent = "Updated ";
    latestRefreshEl.textContent = "never";
    latestRefreshEl.removeAttribute("title");
    return;
  }

  candidates.sort((a, b) => b.getTime() - a.getTime());
  latestRefreshDate = candidates[0];
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
    return compactText(state.token_reason || "token sync failed");
  }
  if (state.studies_headers_ok === false) {
    return compactText(state.studies_headers_reason || "headers capture failed");
  }
  if (state.studies_refresh_ok === false) {
    return compactText(state.studies_refresh_reason || "refresh sync failed");
  }
  if (state.studies_response_capture_ok === false) {
    return compactText(state.studies_response_capture_reason || "response capture failed");
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

async function refreshSettings() {
  try {
    const settings = await getSettings();
    autoOpenToggle.checked = settings.auto_open_prolific_tab !== false;
    const refreshPolicy = normalizeRefreshPolicy(
      settings.studies_refresh_min_delay_seconds,
      settings.studies_refresh_average_delay_seconds,
      settings.studies_refresh_spread_seconds
    );
    applyRefreshPolicyToControls(refreshPolicy);
  } catch (error) {
    setHealthError(error.message);
  }
}

async function refreshView() {
  if (isRefreshingView) {
    return;
  }
  isRefreshingView = true;

  try {
    const [stateResult, refreshResult, studiesResult, eventsResult] = await Promise.allSettled([
      getSyncState(),
      getServiceRefreshState(),
      getLiveStudies(50),
      getLatestEvents(25)
    ]);

    const extensionState = stateResult.status === "fulfilled" ? stateResult.value : null;
    const refreshState = refreshResult.status === "fulfilled" ? refreshResult.value : null;
    const authRequired = isAuthRequiredState(extensionState);
    const serviceResults = [refreshResult, studiesResult, eventsResult];
    const serviceSuccessCount = serviceResults.filter((result) => result.status === "fulfilled").length;
    const serviceUnavailableCount = serviceResults.filter((result) =>
      result.status === "rejected" && isServiceUnavailableError(result.reason)
    ).length;
    const serviceOffline = serviceSuccessCount === 0 && serviceUnavailableCount > 0;

    if (serviceOffline) {
      startOfflineRetryLoop();
    } else {
      stopRetryCountdown();
      scheduleRegularRefresh();

      if (authRequired) {
        renderAuthRequiredPanels();
      } else {
        if (studiesResult.status === "fulfilled") {
          renderLiveStudies(studiesResult.value);
        } else {
          liveStudiesEl.innerHTML = `<div class="empty-events">${escapeHtml(toUserErrorMessage(studiesResult.reason))}</div>`;
        }

        if (eventsResult.status === "fulfilled") {
          renderEvents(eventsResult.value);
        } else {
          eventsEl.innerHTML = `<div class="empty-events">${escapeHtml(toUserErrorMessage(eventsResult.reason))}</div>`;
        }
      }
    }

    const firstError = [stateResult, refreshResult, studiesResult, eventsResult]
      .find((result) => (
        result.status === "rejected" &&
        (!isServiceUnavailableError(result.reason) || serviceOffline)
      ));
    const firstErrorMessage = serviceOffline
      ? SERVICE_OFFLINE_MESSAGE
      : (firstError && firstError.status === "rejected"
        ? toUserErrorMessage(firstError.reason)
        : "");

    if (serviceOffline) {
      renderOfflineLatestRefresh();
    } else if (authRequired) {
      renderSignedOutLatestRefresh();
    } else {
      renderLatestRefresh(refreshState, extensionState);
    }
    renderDebugInfo(extensionState, refreshState);

    let healthMessage = deriveErrorMessage(extensionState, firstErrorMessage);
    if (authRequired) {
      healthMessage = AUTH_REQUIRED_MESSAGE;
    }
    if (!serviceOffline && serviceSuccessCount > 0 && isServiceUnavailableError(healthMessage)) {
      healthMessage = "";
    }
    setHealthError(healthMessage);
  } finally {
    isRefreshingView = false;
  }
}

function scheduleRefreshFromStream() {
  if (streamRefreshTimer) {
    return;
  }
  streamRefreshTimer = setTimeout(() => {
    streamRefreshTimer = null;
    refreshView();
  }, 150);
}

function startEventStream() {
  if (stream) {
    try {
      stream.close();
    } catch {
      // ignore
    }
  }

  try {
    stream = new EventSource("http://localhost:8080/events/stream");
  } catch {
    stream = null;
    return;
  }

  stream.onmessage = () => {
    scheduleRefreshFromStream();
  };

  stream.onerror = () => {
    // EventSource auto-reconnects. Keep fallback polling active.
  };
}

function getRefreshPolicyFromInputs() {
  return normalizeRefreshPolicy(
    refreshMinDelayInput ? refreshMinDelayInput.value : undefined,
    refreshAverageDelayInput ? refreshAverageDelayInput.value : undefined,
    refreshSpreadInput ? refreshSpreadInput.value : undefined
  );
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

    try {
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
      applyRefreshPolicyToControls(normalized);
    } catch (error) {
      setHealthError(error.message);
    }
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
    try {
      await clearDebugLogs();
      await refreshView();
    } catch (error) {
      setHealthError(error.message);
    }
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

refreshSettings();
activateTab("live");
refreshView();
startEventStream();
latestRefreshTicker = setInterval(tickLatestRefreshLabel, 1000);
