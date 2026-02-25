const PROLIFIC_PATTERNS = ["*://*.prolific.com/*"];
const STUDIES_REQUEST_PATTERN = "*://internal-api.prolific.com/api/v1/participant/studies/*";
const OAUTH_TOKEN_PATTERN = "*://auth.prolific.com/oauth/token*";

const SERVICE_BASE_URL = "http://localhost:8080";
const SERVICE_OFFLINE_MESSAGE = "Local service offline, start the Go server to continue.";
const SERVICE_ENDPOINTS = Object.freeze({
  token: `${SERVICE_BASE_URL}/receive-token`,
  clearToken: `${SERVICE_BASE_URL}/clear-token`,
  studiesHeaders: `${SERVICE_BASE_URL}/receive-studies-headers`,
  studiesRefresh: `${SERVICE_BASE_URL}/receive-studies-refresh`,
  studiesResponse: `${SERVICE_BASE_URL}/receive-studies-response`,
  scheduleDelayedRefresh: `${SERVICE_BASE_URL}/schedule-delayed-refresh`
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
let studiesHeaderListenerRegistered = false;
let studiesCompletedListenerRegistered = false;
let studiesResponseCaptureRegistered = false;
let oauthCompletedListenerRegistered = false;
let oauthResponseCaptureRegistered = false;
let stateWriteQueue = Promise.resolve();

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
  const message = (() => {
    if (!error) {
      return "";
    }
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error);
  })();

  const lowered = message.toLowerCase();
  const isNetworkFailure = lowered.includes("failed to fetch") ||
    lowered.includes("networkerror") ||
    lowered.includes("network request failed") ||
    lowered.includes("load failed") ||
    lowered.includes("fetch resource");

  if (isNetworkFailure) {
    return SERVICE_OFFLINE_MESSAGE;
  }

  return message;
}

function rawErrorMessage(error) {
  if (!error) {
    return "";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
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
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") {
      return "";
    }
    if (parsed.hostname !== "internal-api.prolific.com") {
      return "";
    }

    const path = parsed.pathname.replace(/\/+$/, "");
    const expected = STUDIES_COLLECTION_PATH.replace(/\/+$/, "");
    if (path !== expected) {
      return "";
    }

    parsed.pathname = STUDIES_COLLECTION_PATH;
    return parsed.toString();
  } catch {
    return "";
  }
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

async function postJSON(url, payload, errorPrefix) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (stringifyError(error) === SERVICE_OFFLINE_MESSAGE) {
      throw new Error(SERVICE_OFFLINE_MESSAGE);
    }
    throw new Error(rawErrorMessage(error));
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${errorPrefix} returned ${response.status}: ${text}`);
  }
}

async function postTokenToService(payload) {
  await postJSON(SERVICE_ENDPOINTS.token, payload, "Token endpoint");
}

async function clearTokenInService(reason) {
  await postJSON(SERVICE_ENDPOINTS.clearToken, { reason }, "Clear token endpoint");
}

async function postStudiesHeadersToService(payload) {
  await postJSON(SERVICE_ENDPOINTS.studiesHeaders, payload, "Studies header endpoint");
}

async function postStudiesRefreshToService(payload) {
  await postJSON(SERVICE_ENDPOINTS.studiesRefresh, payload, "Studies refresh endpoint");
}

async function postStudiesResponseToService(payload) {
  await postJSON(SERVICE_ENDPOINTS.studiesResponse, payload, "Studies response endpoint");
}

async function scheduleDelayedRefreshCycle(policy, trigger) {
  await postJSON(SERVICE_ENDPOINTS.scheduleDelayedRefresh, {
    policy,
    trigger
  }, "Delayed refresh schedule endpoint");
}

async function setStudiesRefreshState(ok, reason) {
  await setState({
    studies_refresh_ok: ok,
    studies_refresh_reason: ok ? "" : reason,
    studies_refresh_last_at: nowIso()
  });
}

async function maybeAutoOpenProlificTab(trigger) {
  const stored = await chrome.storage.local.get([AUTO_OPEN_PROLIFIC_TAB_KEY]);
  const autoOpenEnabled = stored[AUTO_OPEN_PROLIFIC_TAB_KEY] !== false;

  if (!autoOpenEnabled) {
    await setTokenSyncState({
      ok: false,
      authRequired: false,
      trigger,
      reason: "No open Prolific tab found and auto-open is disabled.",
      extra: {
        token_key: "",
        token_origin: ""
      }
    });
    await setState({
      auto_open_enabled: false
    });
    pushDebugLog("tab.auto_open.disabled", { trigger });
    return false;
  }

  const createdTab = await chrome.tabs.create({
    url: PROLIFIC_STUDIES_URL,
    active: false
  });
  if (createdTab && typeof createdTab.id === "number") {
    try {
      await chrome.tabs.update(createdTab.id, { pinned: true });
    } catch {
      // Best effort.
    }
  }

  await setTokenSyncState({
    ok: false,
    authRequired: false,
    trigger,
    reason: "No open Prolific tab found. Opened one automatically.",
    extra: {
      token_key: "",
      token_origin: ""
    }
  });
  await setState({
    auto_open_enabled: true,
    auto_open_last_opened_at: nowIso()
  });
  bumpCounter("tab_auto_open_count", 1);
  pushDebugLog("tab.auto_open.created", { trigger });

  return true;
}

async function syncTokenOnce(trigger) {
  if (syncInProgress) {
    pushDebugLog("token.sync.skip_in_progress", { trigger });
    return;
  }
  syncInProgress = true;
  pushDebugLog("token.sync.start", { trigger });

  try {
    const tabs = await chrome.tabs.query({ url: PROLIFIC_PATTERNS });
    if (!tabs.length) {
      await maybeAutoOpenProlificTab(trigger);
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
          trigger,
          reason: `Failed to inspect tab ${tab.id}: ${tabError.message}`
        });
      }
    }

    if (!extracted) {
      const reason = "extension.no_oidc_user_token";
      try {
        await clearTokenInService(reason);
        pushDebugLog("token.service_cleared", { trigger, reason });
      } catch (clearError) {
        pushDebugLog("token.service_clear.error", {
          trigger,
          reason,
          error: stringifyError(clearError)
        });
      }

      await setTokenSyncState({
        ok: false,
        authRequired: true,
        trigger,
        reason: "Signed out of Prolific. Log in at app.prolific.com to resume syncing.",
        extra: {
          token_key: "",
          token_origin: ""
        }
      });
      return;
    }

    await postTokenToService({
      access_token: extracted.access_token,
      token_type: extracted.token_type || "Bearer",
      key: extracted.key,
      origin: extracted.origin,
      browser_info: extracted.browser_info || "UTC"
    });

    await setTokenSyncState({
      ok: true,
      authRequired: false,
      trigger,
      reason: "Token synced to Go service.",
      extra: {
        token_key: extracted.key,
        token_origin: extracted.origin,
        token_last_success_at: nowIso()
      }
    });
    bumpCounter("token_sync_success_count", 1);
    pushDebugLog("token.sync.ok", { trigger, tab_origin: extracted.origin });
  } catch (error) {
    await setTokenSyncState({
      ok: false,
      authRequired: false,
      trigger,
      reason: stringifyError(error)
    });
    bumpCounter("token_sync_error_count", 1);
    pushDebugLog("token.sync.error", { trigger, error: stringifyError(error) });
  } finally {
    syncInProgress = false;
  }
}

async function handleOAuthTokenPayload(payload, trigger, originHint) {
  if (!payload || typeof payload !== "object" || !payload.access_token) {
    pushDebugLog("oauth.payload.missing_access_token", { trigger });
    await syncTokenOnce(`${trigger}.fallback_resync`);
    return;
  }

  try {
    const browserInfo = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    await postTokenToService({
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
    await syncTokenOnce(`${trigger}.post_failed_resync`);
  }
}

function tapOAuthTokenResponse(details) {
  const filterResponseData = getFilterResponseDataFunction();
  if (!filterResponseData) {
    return;
  }

  let filter;
  try {
    filter = filterResponseData(details.requestId);
  } catch {
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let bodyText = "";

  filter.ondata = (event) => {
    bodyText += decoder.decode(event.data, { stream: true });
    filter.write(event.data);
  };

  filter.onstop = () => {
    try {
      bodyText += decoder.decode();
      filter.disconnect();
    } catch {
      // ignore
    }

    let parsed = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      syncTokenOnce("oauth_token_response.parse_failed_resync");
      return;
    }

    const originHint = details.initiator || details.originUrl || "https://auth.prolific.com";
    handleOAuthTokenPayload(parsed, "oauth_token_response", originHint);
  };

  filter.onerror = () => {
    try {
      filter.disconnect();
    } catch {
      // ignore
    }
    syncTokenOnce("oauth_token_response.filter_error_resync");
  };
}

function tapStudiesResponse(details) {
  const normalizedURL = normalizeStudiesCollectionURL(details.url);
  if (!normalizedURL) {
    pushDebugLog("studies.response.capture.skip_non_collection", {
      url: details.url,
      request_id: details.requestId
    });
    return;
  }

  const filterResponseData = getFilterResponseDataFunction();
  if (!filterResponseData) {
    return;
  }

  let filter;
  try {
    filter = filterResponseData(details.requestId);
  } catch {
    return;
  }

  const decoder = new TextDecoder("utf-8");
  let bodyText = "";

  filter.ondata = (event) => {
    bodyText += decoder.decode(event.data, { stream: true });
    filter.write(event.data);
  };

  filter.onstop = () => {
    const observedAt = nowIso();
    pushDebugLog("studies.response.capture.stop", {
      url: normalizedURL,
      request_id: details.requestId
    });

    try {
      bodyText += decoder.decode();
      filter.disconnect();
    } catch {
      // ignore
    }

    let parsed = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch (error) {
      bumpCounter("studies_response_parse_error_count", 1);
      setState({
        studies_response_capture_ok: false,
        studies_response_capture_reason: `failed to parse studies response JSON: ${String(error)}`,
        studies_response_capture_last_at: observedAt
      });
      pushDebugLog("studies.response.parse.error", {
        url: normalizedURL,
        error: stringifyError(error)
      });
      return;
    }

    postStudiesResponseToService({
      url: normalizedURL,
      status_code: 200,
      observed_at: observedAt,
      body: parsed
    }).then(() => {
      setState({
        studies_response_capture_ok: true,
        studies_response_capture_reason: "",
        studies_response_capture_last_at: observedAt,
        studies_last_refresh_at: observedAt,
        studies_last_refresh_source: "extension.intercepted_response_body",
        studies_last_refresh_url: normalizedURL,
        studies_last_refresh_status: 200
      });
      bumpCounter("studies_response_ingest_success_count", 1);
      pushDebugLog("studies.response.ingest.ok", {
        url: normalizedURL,
        status_code: 200
      });
    }).catch((error) => {
      bumpCounter("studies_response_ingest_error_count", 1);
      setState({
        studies_response_capture_ok: false,
        studies_response_capture_reason: stringifyError(error),
        studies_response_capture_last_at: observedAt
      });
      pushDebugLog("studies.response.ingest.error", {
        url: normalizedURL,
        error: stringifyError(error)
      });
    });
  };

  filter.onerror = () => {
    try {
      filter.disconnect();
    } catch {
      // ignore
    }

    setState({
      studies_response_capture_ok: false,
      studies_response_capture_reason: "response stream filter error",
      studies_response_capture_last_at: nowIso()
    });
    bumpCounter("studies_response_filter_error_count", 1);
    pushDebugLog("studies.response.filter.error", { url: normalizedURL });
  };
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

    await setState({
      studies_last_refresh_at: payload.captured_at,
      studies_last_refresh_source: "extension.intercepted_request",
      studies_last_refresh_url: payload.url
    });

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

    await postStudiesHeadersToService(payload);
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

  await setState({
    studies_last_refresh_at: observedAt,
    studies_last_refresh_source: "extension.intercepted_response",
    studies_last_refresh_url: normalizedURL,
    studies_last_refresh_status: details.statusCode || 0
  });

  let refreshPostSucceeded = false;
  try {
    await postStudiesRefreshToService({
      observed_at: observedAt,
      source: "extension.intercepted_response",
      url: normalizedURL,
      status_code: details.statusCode || 0,
      delayed_refresh_policy: refreshPolicy
    });

    refreshPostSucceeded = true;
    await setStudiesRefreshState(true, "");
  } catch (error) {
    await setStudiesRefreshState(false, stringifyError(error));
    await bumpCounter("studies_refresh_post_error_count", 1);
    await pushDebugLog("studies.refresh.post.error", {
      url: normalizedURL,
      status_code: details.statusCode || 0,
      error: stringifyError(error)
    });
  }

  if (details.statusCode === 200 && refreshPostSucceeded) {
    await bumpCounter("studies_refresh_post_success_count", 1);
    await pushDebugLog("studies.refresh.post.ok", {
      url: normalizedURL,
      status_code: 200
    });
  }

  if (details.statusCode !== 200) {
    return;
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

function registerStudiesResponseCaptureIfSupported() {
  if (studiesResponseCaptureRegistered) {
    return;
  }

  const filterResponseData = getFilterResponseDataFunction();
  if (!filterResponseData) {
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
    return;
  }

  if (!chrome.webRequest || !chrome.webRequest.onBeforeRequest) {
    return;
  }

  try {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        const normalizedURL = normalizeStudiesCollectionURL(details.url);
        if (!normalizedURL) {
          pushDebugLog("studies.response.capture.before_request.skip_non_collection", {
            url: details.url,
            request_id: details.requestId
          });
          return {};
        }
        bumpCounter("studies_response_before_request_count", 1);
        pushDebugLog("studies.response.capture.before_request", { url: normalizedURL, request_id: details.requestId });
        tapStudiesResponse(details);
        return {};
      },
      { urls: [STUDIES_REQUEST_PATTERN] },
      ["blocking"]
    );

    studiesResponseCaptureRegistered = true;
    setState({
      studies_response_capture_supported: true,
      studies_response_capture_registered: true,
      studies_response_capture_ok: null,
      studies_response_capture_reason: "",
      studies_response_capture_checked_at: nowIso()
    });
    pushDebugLog("studies.response.capture.registered", {});
  } catch (error) {
    setState({
      studies_response_capture_supported: false,
      studies_response_capture_registered: false,
      studies_response_capture_ok: false,
      studies_response_capture_reason: stringifyError(error),
      studies_response_capture_checked_at: nowIso()
    });
    pushDebugLog("studies.response.capture.register_error", { error: stringifyError(error) });
  }
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
      syncTokenOnce("oauth_token_completed_resync");
    },
    { urls: [OAUTH_TOKEN_PATTERN] }
  );

  oauthCompletedListenerRegistered = true;
  pushDebugLog("oauth.completed.listener.registered", {});
}

function registerOAuthResponseCaptureIfSupported() {
  if (oauthResponseCaptureRegistered) {
    return;
  }

  const filterResponseData = getFilterResponseDataFunction();
  if (!filterResponseData) {
    pushDebugLog("oauth.response.capture.unsupported", {
      reason: "filterResponseData not supported"
    });
    return;
  }

  if (!chrome.webRequest || !chrome.webRequest.onBeforeRequest) {
    pushDebugLog("oauth.response.capture.listener.unavailable", {});
    return;
  }

  try {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        tapOAuthTokenResponse(details);
        return {};
      },
      { urls: [OAUTH_TOKEN_PATTERN] },
      ["blocking"]
    );
    oauthResponseCaptureRegistered = true;
    pushDebugLog("oauth.response.capture.registered", {});
  } catch (error) {
    setState({
      oauth_response_capture_supported: false,
      oauth_response_capture_reason: stringifyError(error),
      oauth_response_capture_checked_at: nowIso()
    });
    pushDebugLog("oauth.response.capture.register_error", { error: stringifyError(error) });
  }
}

function schedule() {
  chrome.alarms.create("oidc_sync", { periodInMinutes: 1 });
  pushDebugLog("alarm.scheduled", { name: "oidc_sync", period_minutes: 1 });
}

function registerCaptureListeners() {
  registerStudiesHeaderCapture();
  registerStudiesCompletedCapture();
  registerStudiesResponseCaptureIfSupported();
  registerOAuthCompletedFallbackListener();
  registerOAuthResponseCaptureIfSupported();
}

function boot(trigger, logEvent) {
  if (logEvent) {
    pushDebugLog(logEvent, {});
  }
  schedule();
  registerCaptureListeners();
  syncTokenOnce(trigger);
}

chrome.runtime.onInstalled.addListener(() => {
  boot("onInstalled", "runtime.installed");
});

chrome.runtime.onStartup.addListener(() => {
  boot("onStartup", "runtime.startup");
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "oidc_sync") {
    pushDebugLog("alarm.fired", { name: alarm.name });
    syncTokenOnce("alarm");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) {
    return;
  }
  if (tab.url.includes(".prolific.com")) {
    pushDebugLog("tab.updated.prolific", { tab_id: tabId });
    syncTokenOnce("tabs.onUpdated");
  }
});

chrome.tabs.onRemoved.addListener(() => {
  pushDebugLog("tab.removed", {});
  syncTokenOnce("tabs.onRemoved");
});

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
        settings: {
          auto_open_prolific_tab: data[AUTO_OPEN_PROLIFIC_TAB_KEY] !== false,
          studies_refresh_min_delay_seconds: refreshPolicy.minimum_delay_seconds,
          studies_refresh_average_delay_seconds: refreshPolicy.average_delay_seconds,
          studies_refresh_spread_seconds: refreshPolicy.spread_seconds,
          studies_refresh_cycle_seconds: refreshPolicy.cycle_seconds
        }
      });
    });
    return true;
  }

  if (message && message.action === "setAutoOpen") {
    const enabled = Boolean(message.enabled);
    chrome.storage.local.set({ [AUTO_OPEN_PROLIFIC_TAB_KEY]: enabled }, () => {
      setState({ auto_open_enabled: enabled });
      pushDebugLog("settings.auto_open.updated", { enabled });
      sendResponse({ ok: true, auto_open_prolific_tab: enabled });
    });
    return true;
  }

  if (message && message.action === "setRefreshDelays") {
    (async () => {
      try {
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
          settings: {
            studies_refresh_min_delay_seconds: refreshPolicy.minimum_delay_seconds,
            studies_refresh_average_delay_seconds: refreshPolicy.average_delay_seconds,
            studies_refresh_spread_seconds: refreshPolicy.spread_seconds,
            studies_refresh_cycle_seconds: refreshPolicy.cycle_seconds
          }
        });

        scheduleDelayedRefreshCycle(refreshPolicy, "extension.settings.save")
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
      } catch (error) {
        sendResponse({ ok: false, error: stringifyError(error) });
      }
    })();
    return true;
  }

  if (message && message.action === "clearDebugLogs") {
    updateState(() => ({
      debug_logs: [],
      debug_logs_cleared_at: nowIso()
    })).then(() => {
      sendResponse({ ok: true });
    }).catch((error) => {
      sendResponse({ ok: false, error: stringifyError(error) });
    });
    return true;
  }

  return false;
});

boot("startup-load", "extension.init");
