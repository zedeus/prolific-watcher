const PROLIFIC_PATTERNS = ["*://*.prolific.com/*"];
const STUDIES_REQUEST_PATTERN = "*://internal-api.prolific.com/api/v1/participant/studies/*";
const PARTICIPANT_SUBMISSIONS_PATTERN = "*://internal-api.prolific.com/api/v1/participant/submissions/*";
const SUBMISSIONS_RESERVE_PATTERN = "*://internal-api.prolific.com/api/v1/submissions/reserve/*";
const SUBMISSIONS_TRANSITION_PATTERN = "*://internal-api.prolific.com/api/v1/submissions/*/transition/*";
const SUBMISSION_PATTERNS = [SUBMISSIONS_RESERVE_PATTERN, SUBMISSIONS_TRANSITION_PATTERN];
const OAUTH_TOKEN_PATTERN = "*://auth.prolific.com/oauth/token*";

const SERVICE_BASE_URL = "http://localhost:8080";
const SERVICE_OFFLINE_MESSAGE = "Local service offline, start the Go server to continue.";
const SERVICE_CONNECTING_MESSAGE = "Local service connecting; retrying shortly.";
const SERVICE_WS_URL = SERVICE_BASE_URL.replace(/^http/i, "ws") + "/ws";
const SERVICE_WS_HEARTBEAT_INTERVAL_MS = 10_000;
const SERVICE_WS_HEARTBEAT_TIMEOUT_MS = 25_000;
const SERVICE_WS_RECONNECT_BASE_DELAY_MS = 500;
const SERVICE_WS_RECONNECT_MAX_DELAY_MS = 15_000;
const SERVICE_WS_RECONNECT_JITTER_MS = 250;
const SERVICE_WS_CONNECT_WAIT_MS = 1_500;
const SERVICE_WS_CONNECT_POLL_MS = 50;
const TOKEN_SYNC_RETRY_DELAY_MS = 1_000;
const DASHBOARD_DEFAULT_STUDIES_LIMIT = 50;
const DASHBOARD_DEFAULT_EVENTS_LIMIT = 25;
const DASHBOARD_DEFAULT_SUBMISSIONS_LIMIT = 100;
const DASHBOARD_MIN_LIMIT = 1;
const DASHBOARD_MAX_LIMIT = 500;
const SERVICE_WS_MESSAGE_TYPES = Object.freeze({
  token: "receive-token",
  clearToken: "clear-token",
  studiesHeaders: "receive-studies-headers",
  studiesRefresh: "receive-studies-refresh",
  studiesResponse: "receive-studies-response",
  submissionResponse: "receive-submission-response",
  participantSubmissionsResponse: "receive-participant-submissions-response",
  scheduleDelayedRefresh: "schedule-delayed-refresh"
});
const SERVICE_WS_COMMANDS = Object.freeze({
  token: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.token,
    errorPrefix: "Token endpoint"
  }),
  clearToken: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.clearToken,
    errorPrefix: "Clear token endpoint"
  }),
  studiesHeaders: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.studiesHeaders,
    errorPrefix: "Studies header endpoint"
  }),
  studiesRefresh: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.studiesRefresh,
    errorPrefix: "Studies refresh endpoint"
  }),
  studiesResponse: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.studiesResponse,
    errorPrefix: "Studies response endpoint"
  }),
  submissionResponse: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.submissionResponse,
    errorPrefix: "Submission response endpoint"
  }),
  participantSubmissionsResponse: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.participantSubmissionsResponse,
    errorPrefix: "Participant submissions response endpoint"
  }),
  scheduleDelayedRefresh: Object.freeze({
    messageType: SERVICE_WS_MESSAGE_TYPES.scheduleDelayedRefresh,
    errorPrefix: "Delayed refresh schedule endpoint"
  })
});
const SERVICE_WS_SERVER_EVENT_TYPES = Object.freeze({
  studiesRefreshEvent: "studies_refresh_event"
});

const STATE_KEY = "syncState";
const STUDIES_HEADERS_FINGERPRINT_KEY = "lastSentStudiesHeadersFingerprint";
const AUTO_OPEN_PROLIFIC_TAB_KEY = "autoOpenProlificTab";
const STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY = "studiesRefreshMinDelaySeconds";
const STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY = "studiesRefreshAverageDelaySeconds";
const STUDIES_REFRESH_SPREAD_SECONDS_KEY = "studiesRefreshSpreadSeconds";
const STUDIES_REFRESH_CYCLE_SECONDS = 120;
const DEFAULT_STUDIES_REFRESH_MIN_DELAY_SECONDS = 20;
const DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS = 30;
const DEFAULT_STUDIES_REFRESH_SPREAD_SECONDS = 0;
const MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS = 1;
const MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS = 5;
const MAX_STUDIES_REFRESH_MIN_DELAY_SECONDS = 60;
const MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS = 60;
const MAX_STUDIES_REFRESH_SPREAD_SECONDS = 60;
const DEBUG_LOG_LIMIT = 200;
const DEBUG_LOG_SUPPRESSED_EVENTS = new Set([
  "alarm.scheduled",
  "alarm.fired",
  "token.sync.start",
  "token.sync.skip_in_progress",
  "tab.updated.prolific",
  "tab.removed",
  "studies.request.completed",
  "studies.request.completed.skip_non_collection",
  "studies.response.capture.before_request",
  "studies.response.capture.before_request.skip_non_collection",
  "studies.response.capture.stop",
  "studies.response.capture.skip_non_collection",
  "studies.headers.capture.skip_non_collection",
  "studies.headers.capture.skip_same_fingerprint"
]);

const PROLIFIC_STUDIES_URL = "https://app.prolific.com/studies";
const STUDIES_COLLECTION_PATH = "/api/v1/participant/studies/";

let syncInProgress = false;
let pendingSyncTrigger = "";
let studiesHeaderListenerRegistered = false;
let studiesCompletedListenerRegistered = false;
let studiesResponseCaptureRegistered = false;
let submissionResponseCaptureRegistered = false;
let participantSubmissionsResponseCaptureRegistered = false;
let oauthCompletedListenerRegistered = false;
let oauthResponseCaptureRegistered = false;
let stateWriteQueue = Promise.resolve();
let serviceSocket = null;
let serviceSocketConnectInFlight = false;
let serviceSocketReconnectTimer = null;
let serviceSocketHeartbeatTimer = null;
let serviceSocketReconnectAttempts = 0;
let serviceSocketLastHeartbeatAckAt = 0;
let tokenSyncRetryTimer = null;
let autoOpenInFlight = false;
let lastAutoOpenedTabId = null;

function nowIso() {
  return new Date().toISOString();
}

async function setState(patch) {
  await updateState((previous) => ({
    ...previous,
    ...patch
  }));
}

async function setTokenSyncState({ ok, trigger, reason, authRequired = false, extra = {} }) {
  await setState({
    token_ok: ok,
    token_auth_required: authRequired,
    token_trigger: trigger,
    token_reason: reason,
    ...extra
  });
}

function stringifyError(error) {
  const message = rawErrorMessage(error);
  if (isNetworkFailureMessage(message)) {
    return SERVICE_OFFLINE_MESSAGE;
  }
  return message;
}

function rawErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error == null) {
    return "";
  }
  return String(error);
}

function isNetworkFailureMessage(message) {
  const lowered = String(message || "").toLowerCase();
  return lowered.includes("failed to fetch") ||
    lowered.includes("networkerror") ||
    lowered.includes("network request failed") ||
    lowered.includes("load failed") ||
    lowered.includes("fetch resource");
}

function parseInternalAPIURL(raw) {
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      return null;
    }
    if (parsed.hostname !== "internal-api.prolific.com") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function notifyPopupDashboardUpdated(trigger, observedAt) {
  const normalizedObservedAt = typeof observedAt === "string" ? observedAt.trim() : "";
  const payload = {
    action: "dashboardUpdated",
    trigger: String(trigger || "unknown"),
    observed_at: normalizedObservedAt || nowIso()
  };

  try {
    const maybePromise = chrome.runtime.sendMessage(payload);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch(() => {
        // Popup may be closed; ignore delivery errors.
      });
    }
  } catch {
    // Popup may be closed; ignore delivery errors.
  }
}

function extractObservedAtFromStudiesRefreshEvent(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return "";
  }

  const direct = typeof parsed.at === "string" ? parsed.at.trim() : "";
  const dataObservedAt = parsed.data && typeof parsed.data === "object" && typeof parsed.data.observed_at === "string"
    ? parsed.data.observed_at.trim()
    : "";

  return dataObservedAt || direct || nowIso();
}

function clampDashboardLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(DASHBOARD_MAX_LIMIT, Math.max(DASHBOARD_MIN_LIMIT, parsed));
}

async function fetchServiceJSON(path, contextLabel) {
  let response;
  try {
    response = await fetch(`${SERVICE_BASE_URL}${path}`);
  } catch (error) {
    const message = stringifyError(error);
    if (message === SERVICE_OFFLINE_MESSAGE) {
      throw new Error(SERVICE_OFFLINE_MESSAGE);
    }
    throw new Error(`${contextLabel}: ${rawErrorMessage(error) || "network error"}`);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${contextLabel}: HTTP ${response.status}${text ? ` ${text}` : ""}`);
  }

  return response.json();
}

function extractArrayField(payload, key) {
  if (!payload || !Array.isArray(payload[key])) {
    return [];
  }
  return payload[key];
}

async function loadDashboardData(liveLimit, eventsLimit, submissionsLimit) {
  const [refreshResult, studiesResult, eventsResult, submissionsResult] = await Promise.allSettled([
    fetchServiceJSON("/studies-refresh", "Failed to fetch refresh state"),
    fetchServiceJSON(`/studies?limit=${liveLimit}`, "Failed to fetch live studies"),
    fetchServiceJSON(`/study-events?limit=${eventsLimit}`, "Failed to fetch study events"),
    fetchServiceJSON(`/submissions?phase=all&limit=${submissionsLimit}`, "Failed to fetch submissions")
  ]);

  const parseResult = (result, extractor) => {
    if (result.status === "fulfilled") {
      return {
        ok: true,
        data: extractor(result.value)
      };
    }
    return {
      ok: false,
      error: stringifyError(result.reason)
    };
  };

  return {
    refresh_state: parseResult(refreshResult, (payload) => payload || null),
    studies: parseResult(studiesResult, (payload) => extractArrayField(payload, "results")),
    events: parseResult(eventsResult, (payload) => extractArrayField(payload, "events")),
    submissions: parseResult(submissionsResult, (payload) => extractArrayField(payload, "results"))
  };
}

function normalizeStudiesRefreshPolicy(rawMinimumDelaySeconds, rawAverageDelaySeconds, rawSpreadSeconds) {
  const parseSeconds = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return parsed;
  };

  const averageDelaySeconds = Math.min(
    MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
    Math.max(
      MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
      parseSeconds(rawAverageDelaySeconds, DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS)
    )
  );
  const countByAverage = Math.max(0, Math.floor(STUDIES_REFRESH_CYCLE_SECONDS / averageDelaySeconds) - 1);
  const segments = countByAverage + 1;
  const calculatedCycleSeconds = Math.max(1, Math.floor(STUDIES_REFRESH_CYCLE_SECONDS / segments));
  const maximumMinimumDelaySeconds = Math.max(
    MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS,
    Math.min(MAX_STUDIES_REFRESH_MIN_DELAY_SECONDS, Math.floor(calculatedCycleSeconds / 2))
  );
  const minimumDelaySeconds = Math.min(
    maximumMinimumDelaySeconds,
    Math.max(
      MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS,
      parseSeconds(rawMinimumDelaySeconds, DEFAULT_STUDIES_REFRESH_MIN_DELAY_SECONDS)
    )
  );
  const maximumSpreadSeconds = Math.max(
    0,
    Math.min(MAX_STUDIES_REFRESH_SPREAD_SECONDS, Math.floor(calculatedCycleSeconds / 2))
  );

  const spreadSeconds = Math.min(
    maximumSpreadSeconds,
    Math.max(
      0,
      parseSeconds(rawSpreadSeconds, DEFAULT_STUDIES_REFRESH_SPREAD_SECONDS)
    )
  );

  return {
    minimum_delay_seconds: minimumDelaySeconds,
    average_delay_seconds: averageDelaySeconds,
    spread_seconds: spreadSeconds,
    cycle_seconds: STUDIES_REFRESH_CYCLE_SECONDS
  };
}

async function getStudiesRefreshPolicySettings() {
  const data = await chrome.storage.local.get([
    STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY,
    STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY,
    STUDIES_REFRESH_SPREAD_SECONDS_KEY
  ]);
  return normalizeStudiesRefreshPolicy(
    data[STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY],
    data[STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY],
    data[STUDIES_REFRESH_SPREAD_SECONDS_KEY]
  );
}

function updateState(mutator) {
  stateWriteQueue = stateWriteQueue.then(async () => {
    const existing = await chrome.storage.local.get(STATE_KEY);
    const previous = existing[STATE_KEY] || {};
    const patch = mutator(previous) || {};
    const next = {
      ...previous,
      ...patch,
      updated_at: nowIso()
    };
    await chrome.storage.local.set({ [STATE_KEY]: next });
    return next;
  }).catch(() => {
    // Keep queue alive even when one write fails.
  });
  return stateWriteQueue;
}

function storageSetLocal(items) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };

    try {
      const maybePromise = chrome.storage.local.set(items, () => {
        const runtimeError = chrome.runtime && chrome.runtime.lastError
          ? chrome.runtime.lastError
          : null;
        if (runtimeError) {
          settle(new Error(runtimeError.message || String(runtimeError)));
          return;
        }
        settle(null);
      });

      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(() => settle(null)).catch((error) => settle(error));
      }
    } catch (error) {
      settle(error);
    }
  });
}

async function bumpCounter(counterName, by = 1) {
  try {
    await updateState((previous) => {
      const current = Number(previous[counterName]) || 0;
      return {
        [counterName]: current + by
      };
    });
  } catch {
    // Ignore debug counter errors.
  }
}

async function pushDebugLog(event, details = {}) {
  if (DEBUG_LOG_SUPPRESSED_EVENTS.has(event)) {
    return;
  }

  try {
    await updateState((previous) => {
      const previousLogs = Array.isArray(previous.debug_logs) ? previous.debug_logs : [];
      const now = nowIso();
      const detailsJSON = safeJSONStringify(details);

      let nextLogs = previousLogs;
      const head = previousLogs[0];
      const headDetailsJSON = head && head.details ? safeJSONStringify(head.details) : "{}";
      if (head && head.event === event && headDetailsJSON === detailsJSON) {
        const repeated = Math.max(1, Number(head.repeat_count) || 1) + 1;
        nextLogs = [
          {
            ...head,
            at: now,
            repeat_count: repeated
          },
          ...previousLogs.slice(1)
        ];
      } else {
        nextLogs = [
          {
            at: now,
            event,
            details,
            repeat_count: 1
          },
          ...previousLogs
        ];
      }
      nextLogs = nextLogs.slice(0, DEBUG_LOG_LIMIT);

      return {
        debug_logs: nextLogs,
        debug_log_count_total: (Number(previous.debug_log_count_total) || 0) + 1
      };
    });
  } catch {
    // Ignore debug log write errors.
  }
}

function safeJSONStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "\"[unserializable]\"";
  }
}

async function sha256Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getFilterResponseDataFunction() {
  if (
    typeof browser !== "undefined" &&
    browser.webRequest &&
    typeof browser.webRequest.filterResponseData === "function"
  ) {
    return browser.webRequest.filterResponseData.bind(browser.webRequest);
  }

  if (
    chrome.webRequest &&
    typeof chrome.webRequest.filterResponseData === "function"
  ) {
    return chrome.webRequest.filterResponseData.bind(chrome.webRequest);
  }

  return null;
}

function normalizeStudiesCollectionURL(raw) {
  const parsed = parseInternalAPIURL(raw);
  if (!parsed) {
    return "";
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const expected = STUDIES_COLLECTION_PATH.replace(/\/+$/, "");
  if (path !== expected) {
    return "";
  }

  parsed.pathname = STUDIES_COLLECTION_PATH;
  return parsed.toString();
}

function normalizeSubmissionURL(raw) {
  const parsed = parseInternalAPIURL(raw);
  if (!parsed) {
    return "";
  }

  const path = parsed.pathname.replace(/\/+$/, "/");
  if (path === "/api/v1/submissions/reserve/") {
    parsed.pathname = "/api/v1/submissions/reserve/";
    parsed.search = "";
    return parsed.toString();
  }

  const transitionMatch = path.match(/^\/api\/v1\/submissions\/([^/]+)\/transition\/$/);
  if (!transitionMatch || !transitionMatch[1]) {
    return "";
  }

  parsed.pathname = `/api/v1/submissions/${transitionMatch[1]}/transition/`;
  parsed.search = "";
  return parsed.toString();
}

function normalizeParticipantSubmissionsURL(raw) {
  const parsed = parseInternalAPIURL(raw);
  if (!parsed) {
    return "";
  }

  const path = parsed.pathname.replace(/\/+$/, "/");
  if (path !== "/api/v1/participant/submissions/") {
    return "";
  }

  parsed.pathname = "/api/v1/participant/submissions/";
  return parsed.toString();
}

async function extractTokenFromTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      try {
        let oidcKey = null;
        for (let i = 0; i < window.localStorage.length; i += 1) {
          const key = window.localStorage.key(i);
          if (key && key.startsWith("oidc.user")) {
            oidcKey = key;
            break;
          }
        }

        if (!oidcKey) {
          return { error: "No oidc.user* key found in localStorage." };
        }

        const raw = window.localStorage.getItem(oidcKey);
        if (!raw) {
          return { error: `Key ${oidcKey} has no value.` };
        }

        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (parseError) {
          return { error: `Value for ${oidcKey} is not valid JSON: ${String(parseError)}` };
        }

        if (!parsed || typeof parsed !== "object" || !parsed.access_token) {
          return { error: `Value for ${oidcKey} does not contain access_token.` };
        }

        return {
          key: oidcKey,
          origin: window.location.origin,
          access_token: parsed.access_token,
          token_type: parsed.token_type || "Bearer",
          browser_info: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
  });

  if (!results || !results.length) {
    return { error: "No script execution result." };
  }
  return results[0].result || { error: "Empty script result." };
}

function isServiceSocketReady() {
  return serviceSocket && serviceSocket.readyState === WebSocket.OPEN;
}

function updateServiceSocketState(connected, reason) {
  setState({
    service_ws_connected: connected,
    service_ws_reason: reason,
    service_ws_last_at: nowIso()
  });
}

function startServiceSocketHeartbeatLoop() {
  if (serviceSocketHeartbeatTimer) {
    clearInterval(serviceSocketHeartbeatTimer);
  }

  serviceSocketHeartbeatTimer = setInterval(() => {
    if (!isServiceSocketReady()) {
      return;
    }

    const now = Date.now();
    if (serviceSocketLastHeartbeatAckAt > 0 && now - serviceSocketLastHeartbeatAckAt > SERVICE_WS_HEARTBEAT_TIMEOUT_MS) {
      pushDebugLog("service.ws.heartbeat_timeout", { timeout_ms: SERVICE_WS_HEARTBEAT_TIMEOUT_MS });
      try {
        serviceSocket.close();
      } catch {
        // Best effort.
      }
      return;
    }

    try {
      serviceSocket.send(JSON.stringify({
        type: "heartbeat",
        sent_at: nowIso()
      }));
    } catch {
      // Close handler will trigger reconnect.
      try {
        serviceSocket.close();
      } catch {
        // Best effort.
      }
    }
  }, SERVICE_WS_HEARTBEAT_INTERVAL_MS);
}

function stopServiceSocketHeartbeatLoop() {
  if (serviceSocketHeartbeatTimer) {
    clearInterval(serviceSocketHeartbeatTimer);
    serviceSocketHeartbeatTimer = null;
  }
}

function scheduleServiceSocketReconnect(reason) {
  if (serviceSocketReconnectTimer) {
    return;
  }

  const baseDelay = Math.min(
    SERVICE_WS_RECONNECT_MAX_DELAY_MS,
    SERVICE_WS_RECONNECT_BASE_DELAY_MS * (2 ** serviceSocketReconnectAttempts)
  );
  const jitter = Math.floor(Math.random() * SERVICE_WS_RECONNECT_JITTER_MS);
  const delay = baseDelay + jitter;

  serviceSocketReconnectAttempts += 1;
  serviceSocketReconnectTimer = setTimeout(() => {
    serviceSocketReconnectTimer = null;
    ensureServiceSocketConnected(reason || "reconnect_timer");
  }, delay);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForServiceSocketReady(messageType) {
  if (isServiceSocketReady()) {
    return true;
  }

  ensureServiceSocketConnected(`command:${messageType}`);
  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVICE_WS_CONNECT_WAIT_MS) {
    await sleep(SERVICE_WS_CONNECT_POLL_MS);
    if (isServiceSocketReady()) {
      return true;
    }
    ensureServiceSocketConnected(`command_wait:${messageType}`);
  }
  return isServiceSocketReady();
}

function scheduleTokenSyncRetry(trigger, delayMs = TOKEN_SYNC_RETRY_DELAY_MS) {
  if (tokenSyncRetryTimer) {
    return;
  }

  tokenSyncRetryTimer = setTimeout(() => {
    tokenSyncRetryTimer = null;
    requestTokenSync(trigger).catch(() => {
      // Keep extension resilient.
    });
  }, Math.max(0, Number(delayMs) || 0));
}

function ensureServiceSocketConnected(reason) {
  if (typeof WebSocket === "undefined") {
    return;
  }

  if (isServiceSocketReady() || serviceSocketConnectInFlight) {
    return;
  }

  if (serviceSocket && serviceSocket.readyState === WebSocket.CONNECTING) {
    return;
  }

  if (serviceSocketReconnectTimer) {
    clearTimeout(serviceSocketReconnectTimer);
    serviceSocketReconnectTimer = null;
  }

  let socket;
  try {
    socket = new WebSocket(SERVICE_WS_URL);
  } catch {
    scheduleServiceSocketReconnect("connect_constructor_failed");
    return;
  }

  serviceSocket = socket;
  serviceSocketConnectInFlight = true;

  socket.onopen = () => {
    if (serviceSocket !== socket) {
      return;
    }
    serviceSocketConnectInFlight = false;
    serviceSocketReconnectAttempts = 0;
    serviceSocketLastHeartbeatAckAt = Date.now();
    updateServiceSocketState(true, `connected:${reason}`);
    pushDebugLog("service.ws.connected", { reason });
    startServiceSocketHeartbeatLoop();
    scheduleTokenSyncRetry("service.ws.connected", 0);
  };

  socket.onmessage = (event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      return;
    }

    const messageType = typeof parsed.type === "string" ? parsed.type : "";
    if (messageType === "heartbeat_ack") {
      serviceSocketLastHeartbeatAckAt = Date.now();
      return;
    }

    if (messageType === SERVICE_WS_SERVER_EVENT_TYPES.studiesRefreshEvent) {
      const observedAt = extractObservedAtFromStudiesRefreshEvent(parsed);
      notifyPopupDashboardUpdated("service.ws.studies_refresh_event", observedAt);
      return;
    }

    if (messageType === "ack") {
      if (parsed.ok === false) {
        const errorMessage = typeof parsed.error === "string" && parsed.error
          ? parsed.error
          : "request failed";
        pushDebugLog("service.ws.command_error", { error: errorMessage });
      }
      return;
    }

    if (messageType) {
      pushDebugLog("service.ws.unknown_message_type", {
        type: messageType
      });
    }
  };

  socket.onerror = () => {
    if (serviceSocket !== socket) {
      return;
    }
    pushDebugLog("service.ws.error", { reason });
  };

  socket.onclose = () => {
    if (serviceSocket !== socket) {
      return;
    }

    serviceSocket = null;
    serviceSocketConnectInFlight = false;
    stopServiceSocketHeartbeatLoop();
    updateServiceSocketState(false, "disconnected");
    pushDebugLog("service.ws.disconnected", { reason });
    scheduleServiceSocketReconnect("background_keepalive");
  };
}

function queueServiceSocketMessage(messageType, payload) {
  if (!messageType) {
    throw new Error("missing websocket message type");
  }

  const encoded = JSON.stringify({
    type: messageType,
    sent_at: nowIso(),
    payload
  });

  if (!isServiceSocketReady()) {
    throw new Error(SERVICE_CONNECTING_MESSAGE);
  }

  try {
    serviceSocket.send(encoded);
    return;
  } catch {
    try {
      serviceSocket.close();
    } catch {
      // Best effort.
    }
    pushDebugLog("service.ws.send_failed", { type: messageType });
    ensureServiceSocketConnected(`send_failed:${messageType}`);
    throw new Error(SERVICE_OFFLINE_MESSAGE);
  }
}

async function sendServiceCommand(messageType, payload, errorPrefix) {
  const ready = await waitForServiceSocketReady(messageType);
  if (!ready) {
    pushDebugLog("service.ws.command_dropped_not_connected", {
      type: messageType,
      wait_ms: SERVICE_WS_CONNECT_WAIT_MS
    });
    throw new Error(SERVICE_CONNECTING_MESSAGE);
  }

  try {
    queueServiceSocketMessage(messageType, payload);
  } catch (error) {
    const message = stringifyError(error);
    if (message === SERVICE_OFFLINE_MESSAGE || message === SERVICE_CONNECTING_MESSAGE) {
      throw new Error(message);
    }
    const prefix = errorPrefix || "WebSocket command";
    throw new Error(`${prefix} failed: ${rawErrorMessage(error)}`);
  }
}

function sendServiceCommandByName(commandName, payload) {
  const command = SERVICE_WS_COMMANDS[commandName];
  if (!command) {
    return Promise.reject(new Error(`unknown service command: ${commandName}`));
  }
  return sendServiceCommand(command.messageType, payload, command.errorPrefix);
}

async function setStudiesRefreshState(ok, reason) {
  await setState({
    studies_refresh_ok: ok,
    studies_refresh_reason: ok ? "" : reason,
    studies_refresh_last_at: nowIso()
  });
}

async function queryProlificTabs() {
  const tabs = await chrome.tabs.query({ url: PROLIFIC_PATTERNS });
  return Array.isArray(tabs) ? tabs : [];
}

async function hasTrackedAutoOpenedTab() {
  if (typeof lastAutoOpenedTabId !== "number") {
    return false;
  }
  try {
    const trackedTab = await chrome.tabs.get(lastAutoOpenedTabId);
    return Boolean(trackedTab);
  } catch {
    lastAutoOpenedTabId = null;
    return false;
  }
}

async function setMissingProlificTabState(trigger, reason, autoOpenEnabled) {
  await setTokenSyncState({
    ok: false,
    authRequired: false,
    trigger,
    reason,
    extra: {
      token_key: "",
      token_origin: ""
    }
  });

  const patch = { auto_open_enabled: autoOpenEnabled };
  if (autoOpenEnabled) {
    patch.auto_open_last_opened_at = nowIso();
  }
  await setState(patch);
}

async function maybeAutoOpenProlificTab(trigger, knownProlificTabs) {
  const stored = await chrome.storage.local.get([AUTO_OPEN_PROLIFIC_TAB_KEY]);
  const autoOpenEnabled = stored[AUTO_OPEN_PROLIFIC_TAB_KEY] !== false;

  if (!autoOpenEnabled) {
    await setMissingProlificTabState(
      trigger,
      "No open Prolific tab found and auto-open is disabled.",
      false
    );
    pushDebugLog("tab.auto_open.disabled", { trigger });
    return false;
  }

  // Dedupe strategy: allow only one open in-flight, and do not auto-open
  // again while the last auto-opened tab still exists.
  if (autoOpenInFlight) {
    pushDebugLog("tab.auto_open.dedup_skip", {
      trigger,
      in_flight: true
    });
    return false;
  }

  if (await hasTrackedAutoOpenedTab()) {
    pushDebugLog("tab.auto_open.dedup_skip", {
      trigger,
      in_flight: false,
      last_tab_id: lastAutoOpenedTabId
    });
    return false;
  }

  const existingTabs = Array.isArray(knownProlificTabs) ? knownProlificTabs : await queryProlificTabs();
  if (existingTabs.length > 0) {
    pushDebugLog("tab.auto_open.skip_existing_tab", {
      trigger,
      count: existingTabs.length
    });
    return false;
  }

  autoOpenInFlight = true;
  let createdTab = null;
  try {
    createdTab = await chrome.tabs.create({
      url: PROLIFIC_STUDIES_URL,
      active: false
    });
    if (createdTab && typeof createdTab.id === "number") {
      lastAutoOpenedTabId = createdTab.id;
      try {
        await chrome.tabs.update(createdTab.id, { pinned: true });
      } catch {
        // Best effort.
      }
    }
  } finally {
    autoOpenInFlight = false;
  }

  await setMissingProlificTabState(
    trigger,
    "No open Prolific tab found. Opened one automatically.",
    true
  );
  bumpCounter("tab_auto_open_count", 1);
  pushDebugLog("tab.auto_open.created", { trigger });

  return true;
}

function normalizeSyncTrigger(trigger) {
  const normalized = typeof trigger === "string" ? trigger.trim() : "";
  return normalized || "unknown";
}

function queuePendingTokenSync(trigger) {
  const normalizedTrigger = normalizeSyncTrigger(trigger);
  pendingSyncTrigger = normalizedTrigger;
  pushDebugLog("token.sync.skip_in_progress", { trigger: normalizedTrigger });
}

function drainPendingTokenSync() {
  if (!pendingSyncTrigger) {
    return;
  }

  const queuedTrigger = pendingSyncTrigger;
  pendingSyncTrigger = "";
  Promise.resolve().then(() => {
    requestTokenSync(`${queuedTrigger}.queued`);
  });
}

function requestTokenSync(trigger) {
  return syncTokenOnce(normalizeSyncTrigger(trigger));
}

async function syncTokenOnce(trigger) {
  const normalizedTrigger = normalizeSyncTrigger(trigger);

  if (syncInProgress) {
    queuePendingTokenSync(normalizedTrigger);
    return;
  }
  syncInProgress = true;
  pushDebugLog("token.sync.start", { trigger: normalizedTrigger });

  try {
    const tabs = await queryProlificTabs();
    if (!tabs.length) {
      await maybeAutoOpenProlificTab(normalizedTrigger, tabs);
      return;
    }

    let extracted = null;
    for (const tab of tabs) {
      try {
        const result = await extractTokenFromTab(tab.id);
        if (result && result.access_token) {
          extracted = result;
          break;
        }
      } catch (tabError) {
        await setTokenSyncState({
          ok: false,
          authRequired: false,
          trigger: normalizedTrigger,
          reason: `Failed to inspect tab ${tab.id}: ${tabError.message}`
        });
      }
    }

    if (!extracted) {
      const reason = "extension.no_oidc_user_token";
      try {
        await sendServiceCommandByName("clearToken", { reason });
        pushDebugLog("token.service_cleared", { trigger: normalizedTrigger, reason });
      } catch (clearError) {
        pushDebugLog("token.service_clear.error", {
          trigger: normalizedTrigger,
          reason,
          error: stringifyError(clearError)
        });
      }

      await setTokenSyncState({
        ok: false,
        authRequired: true,
        trigger: normalizedTrigger,
        reason: "Signed out of Prolific. Log in at app.prolific.com to resume syncing.",
        extra: {
          token_key: "",
          token_origin: ""
        }
      });
      return;
    }

    await sendServiceCommandByName("token", {
      access_token: extracted.access_token,
      token_type: extracted.token_type || "Bearer",
      key: extracted.key,
      origin: extracted.origin,
      browser_info: extracted.browser_info || "UTC"
    });

    await setTokenSyncState({
      ok: true,
      authRequired: false,
      trigger: normalizedTrigger,
      reason: "Token synced to Go service.",
      extra: {
        token_key: extracted.key,
        token_origin: extracted.origin,
        token_last_success_at: nowIso()
      }
    });
    bumpCounter("token_sync_success_count", 1);
    pushDebugLog("token.sync.ok", { trigger: normalizedTrigger, tab_origin: extracted.origin });
  } catch (error) {
    const message = stringifyError(error);
    if (message === SERVICE_CONNECTING_MESSAGE) {
      pushDebugLog("token.sync.deferred_service_connecting", { trigger: normalizedTrigger });
      scheduleTokenSyncRetry(`${normalizedTrigger}.service_connecting_retry`);
      return;
    }

    await setTokenSyncState({
      ok: false,
      authRequired: false,
      trigger: normalizedTrigger,
      reason: message
    });
    bumpCounter("token_sync_error_count", 1);
    pushDebugLog("token.sync.error", { trigger: normalizedTrigger, error: message });
  } finally {
    syncInProgress = false;
    drainPendingTokenSync();
  }
}

async function handleOAuthTokenPayload(payload, trigger, originHint) {
  if (!payload || typeof payload !== "object" || !payload.access_token) {
    pushDebugLog("oauth.payload.missing_access_token", { trigger });
    await requestTokenSync(`${trigger}.fallback_resync`);
    return;
  }

  try {
    const browserInfo = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    await sendServiceCommandByName("token", {
      access_token: String(payload.access_token),
      token_type: payload.token_type || "Bearer",
      key: "oauth.token.response",
      origin: originHint || "https://auth.prolific.com",
      browser_info: browserInfo
    });

    await setTokenSyncState({
      ok: true,
      authRequired: false,
      trigger,
      reason: "Captured access_token from oauth/token response.",
      extra: {
        token_key: "oauth.token.response",
        token_origin: originHint || "https://auth.prolific.com",
        token_last_success_at: nowIso()
      }
    });
    bumpCounter("oauth_token_capture_success_count", 1);
    pushDebugLog("oauth.capture.ok", { trigger, origin: originHint || "https://auth.prolific.com" });
  } catch (error) {
    await setTokenSyncState({
      ok: false,
      authRequired: false,
      trigger,
      reason: stringifyError(error)
    });
    bumpCounter("oauth_token_capture_error_count", 1);
    pushDebugLog("oauth.capture.error", { trigger, error: stringifyError(error) });
    await requestTokenSync(`${trigger}.post_failed_resync`);
  }
}

function tapOAuthTokenResponse(details) {
  tapFilteredJSONResponse(details, {
    onParsed: (parsed) => {
      const originHint = details.initiator || details.originUrl || "https://auth.prolific.com";
      handleOAuthTokenPayload(parsed, "oauth_token_response", originHint);
    },
    onParseError: () => {
      requestTokenSync("oauth_token_response.parse_failed_resync");
    },
    onFilterError: () => {
      requestTokenSync("oauth_token_response.filter_error_resync");
    }
  });
}

function safeDisconnectResponseFilter(filter) {
  try {
    filter.disconnect();
  } catch {
    // ignore
  }
}

function tapFilteredJSONResponse(details, handlers) {
  const filterResponseData = getFilterResponseDataFunction();
  if (!filterResponseData) {
    return false;
  }

  let filter;
  try {
    filter = filterResponseData(details.requestId);
  } catch {
    return false;
  }

  const decoder = new TextDecoder("utf-8");
  let bodyText = "";

  filter.ondata = (event) => {
    bodyText += decoder.decode(event.data, { stream: true });
    filter.write(event.data);
  };

  filter.onstop = () => {
    const observedAt = nowIso();
    handlers.onStop?.(observedAt);

    try {
      bodyText += decoder.decode();
    } catch {
      // ignore
    }
    safeDisconnectResponseFilter(filter);

    let parsed = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch (error) {
      handlers.onParseError?.(error, observedAt);
      return;
    }

    handlers.onParsed?.(parsed, observedAt);
  };

  filter.onerror = () => {
    safeDisconnectResponseFilter(filter);
    handlers.onFilterError?.();
  };

  return true;
}

function buildCapturedJSONResponseOptions(config) {
  return Object.freeze({
    normalizeURL: config.normalizeURL,
    statusCode: config.statusCode,
    postToService: (payload) => sendServiceCommandByName(config.commandName, payload),
    parseErrorCounter: `${config.counterPrefix}_parse_error_count`,
    parseErrorEvent: `${config.eventPrefix}.parse.error`,
    ingestSuccessCounter: `${config.counterPrefix}_ingest_success_count`,
    ingestSuccessEvent: `${config.eventPrefix}.ingest.ok`,
    ingestErrorCounter: `${config.counterPrefix}_ingest_error_count`,
    ingestErrorEvent: `${config.eventPrefix}.ingest.error`,
    filterErrorCounter: `${config.counterPrefix}_filter_error_count`,
    filterErrorEvent: `${config.eventPrefix}.filter.error`,
    ...(config.extraHooks || {})
  });
}

const CAPTURED_JSON_RESPONSE_OPTIONS = Object.freeze({
  studies: buildCapturedJSONResponseOptions({
    normalizeURL: normalizeStudiesCollectionURL,
    statusCode: 200,
    commandName: "studiesResponse",
    counterPrefix: "studies_response",
    eventPrefix: "studies.response",
    extraHooks: {
      onSkip: (details) => {
        pushDebugLog("studies.response.capture.skip_non_collection", {
          url: details.url,
          request_id: details.requestId
        });
      },
      onStop: (context) => {
        pushDebugLog("studies.response.capture.stop", {
          url: context.normalizedURL,
          request_id: context.details.requestId
        });
      },
      onParseError: (error, context) => {
        setState({
          studies_response_capture_ok: false,
          studies_response_capture_reason: `failed to parse studies response JSON: ${String(error)}`,
          studies_response_capture_last_at: context.observedAt
        });
      },
      onIngestSuccess: (context) => {
        setState({
          studies_response_capture_ok: true,
          studies_response_capture_reason: "",
          studies_response_capture_last_at: context.observedAt
        });
      },
      onIngestError: (error, context) => {
        setState({
          studies_response_capture_ok: false,
          studies_response_capture_reason: stringifyError(error),
          studies_response_capture_last_at: context.observedAt
        });
      },
      onFilterError: (context) => {
        setState({
          studies_response_capture_ok: false,
          studies_response_capture_reason: "response stream filter error",
          studies_response_capture_last_at: context.observedAt
        });
      }
    }
  }),
  submission: buildCapturedJSONResponseOptions({
    normalizeURL: normalizeSubmissionURL,
    statusCode: 0,
    commandName: "submissionResponse",
    counterPrefix: "submission_response",
    eventPrefix: "submission.response"
  }),
  participantSubmissions: buildCapturedJSONResponseOptions({
    normalizeURL: normalizeParticipantSubmissionsURL,
    statusCode: 200,
    commandName: "participantSubmissionsResponse",
    counterPrefix: "participant_submissions_response",
    eventPrefix: "participant.submissions.response"
  })
});

function tapCapturedJSONResponse(details, options, normalizedURLOverride = "") {
  const normalizedURL = normalizedURLOverride || options.normalizeURL(details.url);
  if (!normalizedURL) {
    options.onSkip?.(details);
    return;
  }

  tapFilteredJSONResponse(details, {
    onStop: (observedAt) => {
      options.onStop?.({
        details,
        normalizedURL,
        observedAt
      });
    },
    onParseError: (error, observedAt) => {
      bumpCounter(options.parseErrorCounter, 1);
      pushDebugLog(options.parseErrorEvent, {
        url: normalizedURL,
        error: stringifyError(error)
      });
      options.onParseError?.(error, {
        details,
        normalizedURL,
        observedAt
      });
    },
    onParsed: (parsed, observedAt) => {
      const context = {
        details,
        normalizedURL,
        observedAt,
        parsed
      };

      options.postToService({
        url: normalizedURL,
        status_code: options.statusCode,
        observed_at: observedAt,
        body: parsed
      }).then(() => {
        bumpCounter(options.ingestSuccessCounter, 1);
        pushDebugLog(options.ingestSuccessEvent, { url: normalizedURL });
        options.onIngestSuccess?.(context);
      }).catch((error) => {
        bumpCounter(options.ingestErrorCounter, 1);
        pushDebugLog(options.ingestErrorEvent, {
          url: normalizedURL,
          error: stringifyError(error)
        });
        options.onIngestError?.(error, context);
      });
    },
    onFilterError: () => {
      const observedAt = nowIso();
      bumpCounter(options.filterErrorCounter, 1);
      pushDebugLog(options.filterErrorEvent, { url: normalizedURL });
      options.onFilterError?.({
        details,
        normalizedURL,
        observedAt
      });
    }
  });
}

function normalizeHeaders(headers) {
  if (!Array.isArray(headers)) {
    return [];
  }

  const normalized = [];
  for (const header of headers) {
    if (!header || !header.name) {
      continue;
    }

    if (typeof header.value === "string") {
      normalized.push({ name: header.name, value: header.value });
      continue;
    }

    if (header.binaryValue && Array.isArray(header.binaryValue)) {
      const value = String.fromCharCode(...header.binaryValue);
      normalized.push({ name: header.name, value });
    }
  }

  return normalized;
}

async function captureStudiesRequestHeaders(details) {
  const normalizedURL = normalizeStudiesCollectionURL(details.url);
  if (!normalizedURL) {
    await pushDebugLog("studies.headers.capture.skip_non_collection", { url: details.url });
    return;
  }

  try {
    const headers = normalizeHeaders(details.requestHeaders);
    if (!headers.length) {
      pushDebugLog("studies.headers.capture.empty_headers", { url: normalizedURL });
      return;
    }

    const payload = {
      url: normalizedURL,
      method: details.method || "GET",
      headers,
      captured_at: nowIso()
    };

    const fingerprint = await sha256Hex(JSON.stringify({
      url: payload.url,
      method: payload.method,
      headers: payload.headers
    }));

    const stored = await chrome.storage.local.get(STUDIES_HEADERS_FINGERPRINT_KEY);
    if (stored[STUDIES_HEADERS_FINGERPRINT_KEY] === fingerprint) {
      bumpCounter("studies_headers_dedupe_skip_count", 1);
      pushDebugLog("studies.headers.capture.skip_same_fingerprint", { url: normalizedURL });
      return;
    }

    await sendServiceCommandByName("studiesHeaders", payload);
    await chrome.storage.local.set({ [STUDIES_HEADERS_FINGERPRINT_KEY]: fingerprint });

    await setState({
      studies_headers_ok: true,
      studies_headers_reason: "Captured studies request headers and sent to Go service.",
      studies_headers_last_at: nowIso(),
      studies_headers_count: headers.length,
      studies_headers_url: normalizedURL
    });
    bumpCounter("studies_headers_capture_success_count", 1);
    pushDebugLog("studies.headers.capture.ok", { url: normalizedURL, count: headers.length });
  } catch (error) {
    await setState({
      studies_headers_ok: false,
      studies_headers_reason: stringifyError(error),
      studies_headers_last_at: nowIso()
    });
    bumpCounter("studies_headers_capture_error_count", 1);
    pushDebugLog("studies.headers.capture.error", { url: normalizedURL, error: stringifyError(error) });
  }
}

async function handleStudiesRequestCompleted(details) {
  const normalizedURL = normalizeStudiesCollectionURL(details.url);
  if (!normalizedURL) {
    await pushDebugLog("studies.request.completed.skip_non_collection", {
      url: details.url,
      status_code: details.statusCode || 0
    });
    return;
  }

  const observedAt = nowIso();
  const refreshPolicy = await getStudiesRefreshPolicySettings();
  await bumpCounter("studies_request_completed_count", 1);
  await pushDebugLog("studies.request.completed", {
    url: normalizedURL,
    status_code: details.statusCode || 0
  });

  try {
    await sendServiceCommandByName("studiesRefresh", {
      observed_at: observedAt,
      source: "extension.intercepted_response",
      url: normalizedURL,
      status_code: details.statusCode || 0,
      delayed_refresh_policy: refreshPolicy
    });

    await setStudiesRefreshState(true, "");

    if (details.statusCode === 200) {
      await bumpCounter("studies_refresh_post_success_count", 1);
      await pushDebugLog("studies.refresh.post.ok", {
        url: normalizedURL,
        status_code: 200
      });
    }
  } catch (error) {
    await setStudiesRefreshState(false, stringifyError(error));
    await bumpCounter("studies_refresh_post_error_count", 1);
    await pushDebugLog("studies.refresh.post.error", {
      url: normalizedURL,
      status_code: details.statusCode || 0,
      error: stringifyError(error)
    });
  }
}

function registerStudiesHeaderCapture() {
  if (studiesHeaderListenerRegistered) {
    return;
  }
  if (!chrome.webRequest || !chrome.webRequest.onBeforeSendHeaders) {
    pushDebugLog("studies.headers.listener.unavailable", {});
    return;
  }

  const listener = (details) => {
    captureStudiesRequestHeaders(details);
  };

  const filter = { urls: [STUDIES_REQUEST_PATTERN] };
  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(listener, filter, ["requestHeaders", "extraHeaders"]);
  } catch {
    chrome.webRequest.onBeforeSendHeaders.addListener(listener, filter, ["requestHeaders"]);
  }
  studiesHeaderListenerRegistered = true;
  pushDebugLog("studies.headers.listener.registered", {});
}

function registerStudiesCompletedCapture() {
  if (studiesCompletedListenerRegistered) {
    return;
  }
  if (!chrome.webRequest || !chrome.webRequest.onCompleted) {
    pushDebugLog("studies.completed.listener.unavailable", {});
    return;
  }

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      handleStudiesRequestCompleted(details);
    },
    { urls: [STUDIES_REQUEST_PATTERN] }
  );

  studiesCompletedListenerRegistered = true;
  pushDebugLog("studies.completed.listener.registered", {});
}

function registerBlockingResponseCapture(options) {
  if (options.isRegistered()) {
    return;
  }

  if (!getFilterResponseDataFunction()) {
    if (options.onUnsupported) {
      options.onUnsupported();
    }
    return;
  }

  if (!chrome.webRequest || !chrome.webRequest.onBeforeRequest) {
    if (options.onListenerUnavailable) {
      options.onListenerUnavailable();
    }
    return;
  }

  try {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        options.onBeforeRequest(details);
        return {};
      },
      { urls: options.urls },
      ["blocking"]
    );

    options.markRegistered();
    if (options.onRegistered) {
      options.onRegistered();
    }
  } catch (error) {
    if (options.onRegisterError) {
      options.onRegisterError(error);
    }
  }
}

function registerJSONBodyResponseCapture(options) {
  registerBlockingResponseCapture({
    isRegistered: options.isRegistered,
    markRegistered: options.markRegistered,
    urls: options.urls,
    onUnsupported: () => {
      pushDebugLog(options.unsupportedEvent, {
        reason: "filterResponseData not supported"
      });
    },
    onListenerUnavailable: () => {
      pushDebugLog(options.unavailableEvent, {});
    },
    onBeforeRequest: (details) => {
      const normalizedURL = options.normalizeURL(details.url);
      if (!normalizedURL) {
        return;
      }
      bumpCounter(options.beforeRequestCounter, 1);
      tapCapturedJSONResponse(details, options.captureOptions, normalizedURL);
    },
    onRegistered: () => {
      pushDebugLog(options.registeredEvent, options.registeredDetails || {});
    },
    onRegisterError: (error) => {
      pushDebugLog(options.registerErrorEvent, { error: stringifyError(error) });
    }
  });
}

function registerStudiesResponseCaptureIfSupported() {
  registerBlockingResponseCapture({
    isRegistered: () => studiesResponseCaptureRegistered,
    markRegistered: () => {
      studiesResponseCaptureRegistered = true;
    },
    urls: [STUDIES_REQUEST_PATTERN],
    onUnsupported: () => {
      const manifest = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest()
        : null;
      const manifestPermissions = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];

      setState({
        studies_response_capture_supported: false,
        studies_response_capture_registered: false,
        studies_response_capture_ok: null,
        studies_response_capture_reason: "filterResponseData not supported",
        studies_response_capture_checked_at: nowIso()
      });
      pushDebugLog("studies.response.capture.unsupported", {
        reason: "filterResponseData not supported",
        manifest_version: manifest ? manifest.manifest_version : "unknown",
        permissions: manifestPermissions
      });
    },
    onBeforeRequest: (details) => {
      const normalizedURL = normalizeStudiesCollectionURL(details.url);
      if (!normalizedURL) {
        pushDebugLog("studies.response.capture.before_request.skip_non_collection", {
          url: details.url,
          request_id: details.requestId
        });
        return;
      }
      bumpCounter("studies_response_before_request_count", 1);
      pushDebugLog("studies.response.capture.before_request", { url: normalizedURL, request_id: details.requestId });
      tapCapturedJSONResponse(details, CAPTURED_JSON_RESPONSE_OPTIONS.studies, normalizedURL);
    },
    onRegistered: () => {
      setState({
        studies_response_capture_supported: true,
        studies_response_capture_registered: true,
        studies_response_capture_ok: null,
        studies_response_capture_reason: "",
        studies_response_capture_checked_at: nowIso()
      });
      pushDebugLog("studies.response.capture.registered", {});
    },
    onRegisterError: (error) => {
      setState({
        studies_response_capture_supported: false,
        studies_response_capture_registered: false,
        studies_response_capture_ok: false,
        studies_response_capture_reason: stringifyError(error),
        studies_response_capture_checked_at: nowIso()
      });
      pushDebugLog("studies.response.capture.register_error", { error: stringifyError(error) });
    }
  });
}

function registerSubmissionResponseCaptureIfSupported() {
  registerJSONBodyResponseCapture({
    isRegistered: () => submissionResponseCaptureRegistered,
    markRegistered: () => {
      submissionResponseCaptureRegistered = true;
    },
    urls: SUBMISSION_PATTERNS,
    normalizeURL: normalizeSubmissionURL,
    beforeRequestCounter: "submission_response_before_request_count",
    captureOptions: CAPTURED_JSON_RESPONSE_OPTIONS.submission,
    unsupportedEvent: "submission.response.capture.unsupported",
    unavailableEvent: "submission.response.capture.listener.unavailable",
    registeredEvent: "submission.response.capture.registered",
    registeredDetails: { patterns: SUBMISSION_PATTERNS },
    registerErrorEvent: "submission.response.capture.register_error"
  });
}

function registerParticipantSubmissionsResponseCaptureIfSupported() {
  registerJSONBodyResponseCapture({
    isRegistered: () => participantSubmissionsResponseCaptureRegistered,
    markRegistered: () => {
      participantSubmissionsResponseCaptureRegistered = true;
    },
    urls: [PARTICIPANT_SUBMISSIONS_PATTERN],
    normalizeURL: normalizeParticipantSubmissionsURL,
    beforeRequestCounter: "participant_submissions_response_before_request_count",
    captureOptions: CAPTURED_JSON_RESPONSE_OPTIONS.participantSubmissions,
    unsupportedEvent: "participant.submissions.response.capture.unsupported",
    unavailableEvent: "participant.submissions.response.capture.listener.unavailable",
    registeredEvent: "participant.submissions.response.capture.registered",
    registeredDetails: { patterns: [PARTICIPANT_SUBMISSIONS_PATTERN] },
    registerErrorEvent: "participant.submissions.response.capture.register_error"
  });
}

function registerOAuthCompletedFallbackListener() {
  if (oauthCompletedListenerRegistered) {
    return;
  }

  if (!chrome.webRequest || !chrome.webRequest.onCompleted) {
    pushDebugLog("oauth.completed.listener.unavailable", {});
    return;
  }

  chrome.webRequest.onCompleted.addListener(
    () => {
      requestTokenSync("oauth_token_completed_resync");
    },
    { urls: [OAUTH_TOKEN_PATTERN] }
  );

  oauthCompletedListenerRegistered = true;
  pushDebugLog("oauth.completed.listener.registered", {});
}

function registerOAuthResponseCaptureIfSupported() {
  registerBlockingResponseCapture({
    isRegistered: () => oauthResponseCaptureRegistered,
    markRegistered: () => {
      oauthResponseCaptureRegistered = true;
    },
    urls: [OAUTH_TOKEN_PATTERN],
    onUnsupported: () => {
      pushDebugLog("oauth.response.capture.unsupported", {
        reason: "filterResponseData not supported"
      });
    },
    onListenerUnavailable: () => {
      pushDebugLog("oauth.response.capture.listener.unavailable", {});
    },
    onBeforeRequest: (details) => {
      tapOAuthTokenResponse(details);
    },
    onRegistered: () => {
      pushDebugLog("oauth.response.capture.registered", {});
    },
    onRegisterError: (error) => {
      setState({
        oauth_response_capture_supported: false,
        oauth_response_capture_reason: stringifyError(error),
        oauth_response_capture_checked_at: nowIso()
      });
      pushDebugLog("oauth.response.capture.register_error", { error: stringifyError(error) });
    }
  });
}

function schedule() {
  chrome.alarms.create("oidc_sync", { periodInMinutes: 1 });
  pushDebugLog("alarm.scheduled", { name: "oidc_sync", period_minutes: 1 });
}

function registerCaptureListeners() {
  registerStudiesHeaderCapture();
  registerStudiesCompletedCapture();
  registerStudiesResponseCaptureIfSupported();
  registerSubmissionResponseCaptureIfSupported();
  registerParticipantSubmissionsResponseCaptureIfSupported();
  registerOAuthCompletedFallbackListener();
  registerOAuthResponseCaptureIfSupported();
}

async function boot(trigger, logEvent) {
  if (logEvent) {
    await pushDebugLog(logEvent, {});
  }
  ensureServiceSocketConnected(`boot:${trigger}`);
  schedule();
  registerCaptureListeners();
  await requestTokenSync(trigger);
}

chrome.runtime.onInstalled.addListener(() => {
  boot("onInstalled", "runtime.installed").catch(() => {
    // Keep extension startup resilient.
  });
});

chrome.runtime.onStartup.addListener(() => {
  boot("onStartup", "runtime.startup").catch(() => {
    // Keep extension startup resilient.
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "oidc_sync") {
    pushDebugLog("alarm.fired", { name: alarm.name });
    requestTokenSync("alarm");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) {
    return;
  }
  if (tab.url.includes(".prolific.com")) {
    pushDebugLog("tab.updated.prolific", { tab_id: tabId });
    requestTokenSync("tabs.onUpdated");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (typeof tabId === "number" && tabId === lastAutoOpenedTabId) {
    lastAutoOpenedTabId = null;
  }
  pushDebugLog("tab.removed", { tab_id: tabId });
  requestTokenSync("tabs.onRemoved");
});

function buildRefreshSettingsResponse(refreshPolicy, autoOpenEnabled) {
  const settings = {
    studies_refresh_min_delay_seconds: refreshPolicy.minimum_delay_seconds,
    studies_refresh_average_delay_seconds: refreshPolicy.average_delay_seconds,
    studies_refresh_spread_seconds: refreshPolicy.spread_seconds,
    studies_refresh_cycle_seconds: refreshPolicy.cycle_seconds
  };
  if (typeof autoOpenEnabled === "boolean") {
    settings.auto_open_prolific_tab = autoOpenEnabled;
  }
  return settings;
}

function sendRuntimeError(sendResponse, error) {
  sendResponse({ ok: false, error: stringifyError(error) });
}

function runMessageTask(sendResponse, task) {
  (async () => {
    try {
      await task();
    } catch (error) {
      sendRuntimeError(sendResponse, error);
    }
  })();
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === "getState") {
    chrome.storage.local.get(STATE_KEY, (data) => {
      sendResponse({ ok: true, state: data[STATE_KEY] || null });
    });
    return true;
  }

  if (message && message.action === "getSettings") {
    chrome.storage.local.get([
      AUTO_OPEN_PROLIFIC_TAB_KEY,
      STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY,
      STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY,
      STUDIES_REFRESH_SPREAD_SECONDS_KEY
    ], (data) => {
      const refreshPolicy = normalizeStudiesRefreshPolicy(
        data[STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY],
        data[STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY],
        data[STUDIES_REFRESH_SPREAD_SECONDS_KEY]
      );
      sendResponse({
        ok: true,
        settings: buildRefreshSettingsResponse(
          refreshPolicy,
          data[AUTO_OPEN_PROLIFIC_TAB_KEY] !== false
        )
      });
    });
    return true;
  }

  if (message && message.action === "getDashboardData") {
    return runMessageTask(sendResponse, async () => {
      const liveLimit = clampDashboardLimit(
        message.live_limit,
        DASHBOARD_DEFAULT_STUDIES_LIMIT
      );
      const eventsLimit = clampDashboardLimit(
        message.events_limit,
        DASHBOARD_DEFAULT_EVENTS_LIMIT
      );
      const submissionsLimit = clampDashboardLimit(
        message.submissions_limit,
        DASHBOARD_DEFAULT_SUBMISSIONS_LIMIT
      );

      const dashboard = await loadDashboardData(liveLimit, eventsLimit, submissionsLimit);
      sendResponse({ ok: true, dashboard });
    });
  }

  if (message && message.action === "setAutoOpen") {
    return runMessageTask(sendResponse, async () => {
      const enabled = Boolean(message.enabled);
      await storageSetLocal({ [AUTO_OPEN_PROLIFIC_TAB_KEY]: enabled });
      await setState({ auto_open_enabled: enabled });
      await pushDebugLog("settings.auto_open.updated", { enabled });

      sendResponse({ ok: true, auto_open_prolific_tab: enabled });

      if (!enabled) {
        lastAutoOpenedTabId = null;
        return;
      }

      const tabs = await queryProlificTabs();
      if (tabs.length === 0) {
        await maybeAutoOpenProlificTab("settings.auto_open.enabled", tabs);
        return;
      }

      await requestTokenSync("settings.auto_open.enabled");
    });
  }

  if (message && message.action === "setRefreshDelays") {
    return runMessageTask(sendResponse, async () => {
      const refreshPolicy = normalizeStudiesRefreshPolicy(
        message.minimum_delay_seconds,
        message.average_delay_seconds,
        message.spread_seconds
      );

      await storageSetLocal({
        [STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY]: refreshPolicy.minimum_delay_seconds,
        [STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY]: refreshPolicy.average_delay_seconds,
        [STUDIES_REFRESH_SPREAD_SECONDS_KEY]: refreshPolicy.spread_seconds
      });

      sendResponse({
        ok: true,
        settings: buildRefreshSettingsResponse(refreshPolicy)
      });

      sendServiceCommandByName("scheduleDelayedRefresh", {
        policy: refreshPolicy,
        trigger: "extension.settings.save"
      })
        .then(() => {
          pushDebugLog("settings.studies_refresh_policy.schedule_ok", refreshPolicy);
        })
        .catch((error) => {
          pushDebugLog("settings.studies_refresh_policy.schedule_error", { error: stringifyError(error) });
        });

      setState({
        studies_refresh_min_delay_seconds: refreshPolicy.minimum_delay_seconds,
        studies_refresh_average_delay_seconds: refreshPolicy.average_delay_seconds,
        studies_refresh_spread_seconds: refreshPolicy.spread_seconds,
        studies_refresh_cycle_seconds: refreshPolicy.cycle_seconds
      });
      pushDebugLog("settings.studies_refresh_policy.updated", refreshPolicy);
    });
  }

  if (message && message.action === "clearDebugLogs") {
    return runMessageTask(sendResponse, async () => {
      await updateState(() => ({
        debug_logs: [],
        debug_logs_cleared_at: nowIso()
      }));
      sendResponse({ ok: true });
    });
  }

  return false;
});

boot("startup-load", "extension.init").catch(() => {
  // Keep extension startup resilient.
});
