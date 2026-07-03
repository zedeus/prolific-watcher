import { browser } from 'wxt/browser';
import { nowIso, toUserErrorMessage } from '../../lib/format';
import { normalizeStudy } from '../../lib/normalize';
import type { PriorityFilter, Study, TelegramSettings } from '../../lib/types';
import type { SoundType } from '../../lib/constants';
import {
  ingestStudiesResponse,
  ingestSubmissionResponse,
  ingestParticipantSubmissionsResponse,
} from './ingest';
import * as store from '../../lib/store';
import {
  PROLIFIC_PATTERNS,
  STUDIES_REQUEST_PATTERN,
  PARTICIPANT_SUBMISSIONS_PATTERN,
  SUBMISSION_PATTERNS,
  OAUTH_TOKEN_PATTERN,
  PROLIFIC_STUDIES_URL,
  STUDIES_COLLECTION_PATH,
  FETCH_STUDIES_API_URL,
  STATE_KEY,
  PRIORITY_KNOWN_STUDIES_STATE_KEY,
  AUTO_OPEN_PROLIFIC_TAB_KEY,
  PRIORITY_FILTERS_KEY,
  STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY,
  STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY,
  STUDIES_REFRESH_SPREAD_SECONDS_KEY,
  STUDIES_REFRESH_CYCLE_SECONDS,
  STUDY_HISTORY_PRUNE_PERIOD_MINUTES,
  DEFAULT_STUDIES_REFRESH_MIN_DELAY_SECONDS,
  DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
  DEFAULT_STUDIES_REFRESH_SPREAD_SECONDS,
  MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS,
  MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
  MAX_STUDIES_REFRESH_MIN_DELAY_SECONDS,
  MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
  MAX_STUDIES_REFRESH_SPREAD_SECONDS,
  DEFAULT_PRIORITY_FILTER_MIN_REWARD,
  DEFAULT_PRIORITY_FILTER_MIN_HOURLY_REWARD,
  DEFAULT_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
  DEFAULT_PRIORITY_FILTER_MIN_PLACES,
  MIN_PRIORITY_FILTER_MIN_REWARD,
  MAX_PRIORITY_FILTER_MIN_REWARD,
  MIN_PRIORITY_FILTER_MIN_HOURLY_REWARD,
  MAX_PRIORITY_FILTER_MIN_HOURLY_REWARD,
  MIN_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
  MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
  MIN_PRIORITY_FILTER_MIN_PLACES,
  MAX_PRIORITY_FILTER_MIN_PLACES,
  MAX_PRIORITY_FILTER_KEYWORDS,
  MAX_PRIORITY_STUDY_AUTO_OPEN_PER_BATCH,
  PRIORITY_KNOWN_STUDIES_TTL_MS,
  MAX_PRIORITY_KNOWN_STUDIES,
  PRIORITY_ACTION_SEEN_TTL_MS,
  MAX_PRIORITY_ACTION_SEEN_STUDIES,
  PRIORITY_ALERT_COOLDOWN_MS,
  TELEGRAM_NOTIFY_COOLDOWN_MS,
  DEFAULT_PRIORITY_ALERT_SOUND_TYPE,
  DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
  MIN_PRIORITY_ALERT_SOUND_VOLUME,
  MAX_PRIORITY_ALERT_SOUND_VOLUME,
  PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH,
  DEBUG_LOG_LIMIT,
  DEBUG_LOG_SUPPRESSED_EVENTS,
  STORAGE_PRESSURE_WARN_RATIO,
  STORAGE_PRESSURE_CRITICAL_RATIO,
  STORAGE_QUOTA_CHECK_PERIOD_MINUTES,
  STUDY_HISTORY_CRITICAL_ROW_CAP,
  REFRESH_PERSISTENT_FAILURE_THRESHOLD,
  AUTH_EXPIRY_RESYNC_MAX_ATTEMPTS,
  AUTH_EXPIRY_RELOAD_MAX_ATTEMPTS,
  REFRESH_RECONNECTING_MESSAGE,
  REFRESH_PERSISTENT_FAILURE_MESSAGE,
  AUTH_REQUIRED_MESSAGE,
} from '../../lib/constants';
import {
  evaluatePrioritySnapshotEvent,
  toFullSnapshotEvent,
} from './domain';
import type { NormalizedSnapshotEvent } from './domain';
import {
  classifyRefreshStatus,
  classifyStoragePressure,
  decideAuthRecoveryAction,
  isQuotaError,
  createRefreshHealthTracker,
  type RefreshOutcome,
  type RefreshHealthSnapshot,
  type StorageEstimateInput,
} from './health';
import { createPriorityState } from './state';
import { createPriorityActions } from './actions';
import { createPrioritySettings } from './settings';
import {
  loadTelegramSettings,
  saveTelegramSettings,
  normalizeTelegramSettings,
  isTelegramConfigured,
  sendTelegramMessage,
  sendTelegramTestMessage,
  verifyTelegramBot,
  formatTelegramMessage,
  buildStudyReplyMarkup,
} from './telegram';

export default defineBackground({
  main() {
    // ─────────────────────────────────────────────────────────────
    // Mutable state
    // ─────────────────────────────────────────────────────────────

    // Tracks whether the extension is currently performing its own studies fetch.
    // Used to prevent double-processing: the content script and webRequest.onCompleted
    // skip interception while this is true, since the delayed refresh handler
    // already processes the response directly.
    let extensionFetchInProgress = false;

    let delayedRefreshTimers: ReturnType<typeof setTimeout>[] = [];
    let delayedRefreshGeneration = 0;

    // Rate-limit cooldown: suppresses extension-initiated fetches until cooldown expires
    let rateLimitCooldownUntilMS = 0;
    let rateLimitReloadTimer: ReturnType<typeof setTimeout> | null = null;

    // Dedup guard: skip delayed refreshes that fire near an intercepted tab response
    const DEDUP_WINDOW_MS = 10_000;
    let lastInterceptedResponseAtMS = 0;

    let syncInProgress = false;
    let pendingSyncTrigger = '';
    let studiesCompletedListenerRegistered = false;
    let studiesResponseCaptureRegistered = false;
    let submissionResponseCaptureRegistered = false;
    let participantSubmissionsResponseCaptureRegistered = false;
    let oauthCompletedListenerRegistered = false;
    let oauthResponseCaptureRegistered = false;
    let stateWriteQueue: Promise<void | Record<string, unknown>> = Promise.resolve();
    let autoOpenInFlight = false;
    let lastAutoOpenedTabId: number | null = null;

    // Backend resilience (issue #25): pause our own studies fetches while an expired token is being
    // recovered, and track consecutive refresh failures so a persistent stall surfaces to the popup.
    let authExpiryPauseActive = false;
    let storageCheckInFlight = false;
    let pendingEmergencyPrune = false;
    const refreshHealth = createRefreshHealthTracker({
      persistentThreshold: REFRESH_PERSISTENT_FAILURE_THRESHOLD,
    });

    // ─────────────────────────────────────────────────────────────
    // Priority module initialization
    // ─────────────────────────────────────────────────────────────

    const prioritySettings = createPrioritySettings({
      limits: {
        maxKeywords: MAX_PRIORITY_FILTER_KEYWORDS,
        minMinReward: MIN_PRIORITY_FILTER_MIN_REWARD,
        maxMinReward: MAX_PRIORITY_FILTER_MIN_REWARD,
        minMinHourlyReward: MIN_PRIORITY_FILTER_MIN_HOURLY_REWARD,
        maxMinHourlyReward: MAX_PRIORITY_FILTER_MIN_HOURLY_REWARD,
        minEstimatedMinutes: MIN_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
        maxEstimatedMinutes: MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
        minMinimumPlaces: MIN_PRIORITY_FILTER_MIN_PLACES,
        maxMinimumPlaces: MAX_PRIORITY_FILTER_MIN_PLACES,
        minAlertSoundVolume: MIN_PRIORITY_ALERT_SOUND_VOLUME,
        maxAlertSoundVolume: MAX_PRIORITY_ALERT_SOUND_VOLUME,
      },
      defaults: {
        minimumRewardMajor: DEFAULT_PRIORITY_FILTER_MIN_REWARD,
        minimumHourlyRewardMajor: DEFAULT_PRIORITY_FILTER_MIN_HOURLY_REWARD,
        maximumEstimatedMinutes: DEFAULT_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
        minimumPlacesAvailable: DEFAULT_PRIORITY_FILTER_MIN_PLACES,
        alertSoundType: DEFAULT_PRIORITY_ALERT_SOUND_TYPE as SoundType,
        alertSoundVolume: DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
      },
    });

    const {
      normalizePriorityFilters,
      getPriorityFilters,
      migrateLegacyPriorityFilter,
    } = prioritySettings;

    const priorityStateRuntime = createPriorityState({
      storageKey: PRIORITY_KNOWN_STUDIES_STATE_KEY,
      nowIso,
      limits: {
        knownStudiesTTLMS: PRIORITY_KNOWN_STUDIES_TTL_MS,
        maxKnownStudies: MAX_PRIORITY_KNOWN_STUDIES,
        actionSeenTTLMS: PRIORITY_ACTION_SEEN_TTL_MS,
        maxActionSeenStudies: MAX_PRIORITY_ACTION_SEEN_STUDIES,
        telegramSeenTTLMS: TELEGRAM_NOTIFY_COOLDOWN_MS,
      },
      onQueueError: (error: unknown, event: NormalizedSnapshotEvent) => {
        pushDebugLog('tab.priority_auto_open.error', {
          trigger: event.trigger,
          error: stringifyError(error),
        });
      },
    });

    // ─────────────────────────────────────────────────────────────
    // State management functions
    // ─────────────────────────────────────────────────────────────

    function updateState(mutator: (previous: Record<string, unknown>) => Record<string, unknown> | null): Promise<void | Record<string, unknown>> {
      stateWriteQueue = stateWriteQueue.then(async () => {
        const existing = await browser.storage.local.get(STATE_KEY);
        const previous = (existing[STATE_KEY] as Record<string, unknown>) || {};
        const patch = mutator(previous) || {};
        const next: Record<string, unknown> = {
          ...previous,
          ...patch,
          updated_at: nowIso(),
        };
        await browser.storage.local.set({ [STATE_KEY]: next });
        return next;
      }).catch(() => {
        // Keep queue alive even when one write fails.
      });
      return stateWriteQueue;
    }

    async function setState(patch: Record<string, unknown>): Promise<void> {
      await updateState((previous) => ({
        ...previous,
        ...patch,
      }));
    }

    async function setTokenSyncState({ ok, trigger, reason, authRequired = false, extra = {} }: {
      ok: boolean | null;
      trigger: string;
      reason: string;
      authRequired?: boolean;
      extra?: Record<string, unknown>;
    }): Promise<void> {
      await setState({
        token_ok: ok,
        token_auth_required: authRequired,
        token_trigger: trigger,
        token_reason: reason,
        ...extra,
      });
    }

    function storageSetLocal(items: Record<string, unknown>): Promise<void> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (err: Error | null) => {
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
          const maybePromise = browser.storage.local.set(items);

          if (maybePromise && typeof (maybePromise as Promise<void>).then === 'function') {
            (maybePromise as Promise<void>).then(() => settle(null)).catch((error: unknown) => settle(error as Error));
          } else {
            // Callback-based path (Chrome MV2 style) — should not happen with wxt/browser
            // but handle defensively.
            settle(null);
          }
        } catch (error) {
          settle(error as Error);
        }
      });
    }

    async function bumpCounter(counterName: string, by: number = 1): Promise<void> {
      try {
        await updateState((previous) => {
          const current = Number(previous[counterName]) || 0;
          return {
            [counterName]: current + by,
          };
        });
      } catch {
        // Ignore debug counter errors.
      }
    }

    async function pushDebugLog(event: string, details: Record<string, unknown> = {}): Promise<void> {
      if (DEBUG_LOG_SUPPRESSED_EVENTS.has(event)) {
        return;
      }

      try {
        await updateState((previous) => {
          const previousLogs = Array.isArray(previous.debug_logs) ? previous.debug_logs as Array<Record<string, unknown>> : [];
          const now = nowIso();
          const detailsJSON = safeJSONStringify(details);

          let nextLogs: Array<Record<string, unknown>>;
          const head = previousLogs[0];
          const headDetailsJSON = head && head.details ? safeJSONStringify(head.details) : '{}';
          if (head && head.event === event && headDetailsJSON === detailsJSON) {
            const repeated = Math.max(1, Number(head.repeat_count) || 1) + 1;
            nextLogs = [
              {
                ...head,
                at: now,
                repeat_count: repeated,
              },
              ...previousLogs.slice(1),
            ];
          } else {
            nextLogs = [
              {
                at: now,
                event,
                details,
                repeat_count: 1,
              },
              ...previousLogs,
            ];
          }
          nextLogs = nextLogs.slice(0, DEBUG_LOG_LIMIT);

          return {
            debug_logs: nextLogs,
            debug_log_count_total: (Number(previous.debug_log_count_total) || 0) + 1,
          };
        });
      } catch {
        // Ignore debug log write errors.
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Helper functions
    // ─────────────────────────────────────────────────────────────

    function stringifyError(error: unknown): string {
      return rawErrorMessage(error);
    }

    function rawErrorMessage(error: unknown): string {
      if (error instanceof Error && error.message) {
        return error.message;
      }
      if (error == null) {
        return '';
      }
      return String(error);
    }

    function parseInternalAPIURL(raw: string | null | undefined): URL | null {
      if (!raw) {
        return null;
      }
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:') {
          return null;
        }
        if (parsed.hostname !== 'internal-api.prolific.com') {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    }

    function safeJSONStringify(value: unknown): string {
      try {
        return JSON.stringify(value);
      } catch {
        return '"[unserializable]"';
      }
    }

    function notifyPopupDashboardUpdated(trigger: string, observedAt: string): void {
      const normalizedObservedAt = typeof observedAt === 'string' ? observedAt.trim() : '';
      const payload = {
        action: 'dashboardUpdated',
        trigger: String(trigger || 'unknown'),
        observed_at: normalizedObservedAt || nowIso(),
      };

      try {
        const maybePromise = browser.runtime.sendMessage(payload);
        if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === 'function') {
          (maybePromise as Promise<unknown>).catch(() => {
            // Popup may be closed; ignore delivery errors.
          });
        }
      } catch {
        // Popup may be closed; ignore delivery errors.
      }
    }



    function normalizeStudiesRefreshPolicy(rawMinimumDelaySeconds: unknown, rawAverageDelaySeconds: unknown, rawSpreadSeconds: unknown): Record<string, number> {
      const parseSeconds = (value: unknown, fallback: number): number => {
        const parsed = Number.parseInt(String(value), 10);
        if (!Number.isFinite(parsed)) {
          return fallback;
        }
        return parsed;
      };

      const averageDelaySeconds = Math.min(
        MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
        Math.max(
          MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS,
          parseSeconds(rawAverageDelaySeconds, DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS),
        ),
      );
      const countByAverage = Math.max(0, Math.floor(STUDIES_REFRESH_CYCLE_SECONDS / averageDelaySeconds) - 1);
      const segments = countByAverage + 1;
      const calculatedCycleSeconds = Math.max(1, Math.floor(STUDIES_REFRESH_CYCLE_SECONDS / segments));
      const maximumMinimumDelaySeconds = Math.max(
        MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS,
        Math.min(MAX_STUDIES_REFRESH_MIN_DELAY_SECONDS, Math.floor(calculatedCycleSeconds / 2)),
      );
      const minimumDelaySeconds = Math.min(
        maximumMinimumDelaySeconds,
        Math.max(
          MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS,
          parseSeconds(rawMinimumDelaySeconds, DEFAULT_STUDIES_REFRESH_MIN_DELAY_SECONDS),
        ),
      );
      const maximumSpreadSeconds = Math.max(
        0,
        Math.min(MAX_STUDIES_REFRESH_SPREAD_SECONDS, Math.floor(calculatedCycleSeconds / 2)),
      );

      const spreadSeconds = Math.min(
        maximumSpreadSeconds,
        Math.max(
          0,
          parseSeconds(rawSpreadSeconds, DEFAULT_STUDIES_REFRESH_SPREAD_SECONDS),
        ),
      );

      return {
        minimum_delay_seconds: minimumDelaySeconds,
        average_delay_seconds: averageDelaySeconds,
        spread_seconds: spreadSeconds,
        cycle_seconds: STUDIES_REFRESH_CYCLE_SECONDS,
      };
    }

    async function getStudiesRefreshPolicySettings(): Promise<Record<string, number>> {
      const data = await browser.storage.local.get([
        STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY,
        STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY,
        STUDIES_REFRESH_SPREAD_SECONDS_KEY,
      ]);
      return normalizeStudiesRefreshPolicy(
        data[STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY],
        data[STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY],
        data[STUDIES_REFRESH_SPREAD_SECONDS_KEY],
      );
    }

    // ─────────────────────────────────────────────────────────────
    // URL normalization
    // ─────────────────────────────────────────────────────────────

    function normalizeStudiesCollectionURL(raw: string): string {
      const parsed = parseInternalAPIURL(raw);
      if (!parsed) {
        return '';
      }

      const path = parsed.pathname.replace(/\/+$/, '');
      const expected = STUDIES_COLLECTION_PATH.replace(/\/+$/, '');
      if (path !== expected) {
        return '';
      }

      parsed.pathname = STUDIES_COLLECTION_PATH;
      return parsed.toString();
    }

    function normalizeSubmissionURL(raw: string): string {
      const parsed = parseInternalAPIURL(raw);
      if (!parsed) {
        return '';
      }

      const path = parsed.pathname.replace(/\/+$/, '/');
      if (path === '/api/v1/submissions/reserve/') {
        parsed.pathname = '/api/v1/submissions/reserve/';
        parsed.search = '';
        return parsed.toString();
      }

      const transitionMatch = path.match(/^\/api\/v1\/submissions\/([^/]+)\/transition\/$/);
      if (!transitionMatch || !transitionMatch[1]) {
        return '';
      }

      parsed.pathname = `/api/v1/submissions/${transitionMatch[1]}/transition/`;
      parsed.search = '';
      return parsed.toString();
    }

    function normalizeParticipantSubmissionsURL(raw: string): string {
      const parsed = parseInternalAPIURL(raw);
      if (!parsed) {
        return '';
      }

      const path = parsed.pathname.replace(/\/+$/, '/');
      if (path !== '/api/v1/participant/submissions/') {
        return '';
      }

      parsed.pathname = '/api/v1/participant/submissions/';
      return parsed.toString();
    }

    // ─────────────────────────────────────────────────────────────
    // Token extraction
    // ─────────────────────────────────────────────────────────────

    async function extractTokenFromTab(tabId: number): Promise<Record<string, unknown>> {
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId },
          func: () => {
            try {
              let oidcKey: string | null = null;
              for (let i = 0; i < window.localStorage.length; i += 1) {
                const key = window.localStorage.key(i);
                if (key && key.startsWith('oidc.user')) {
                  oidcKey = key;
                  break;
                }
              }

              if (!oidcKey) {
                return { error: 'No oidc.user* key found in localStorage.' };
              }

              const raw = window.localStorage.getItem(oidcKey);
              if (!raw) {
                return { error: `Key ${oidcKey} has no value.` };
              }

              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(raw);
              } catch (parseError) {
                return { error: `Value for ${oidcKey} is not valid JSON: ${String(parseError)}` };
              }

              if (!parsed || typeof parsed !== 'object' || !parsed.access_token) {
                return { error: `Value for ${oidcKey} does not contain access_token.` };
              }

              return {
                key: oidcKey,
                origin: window.location.origin,
                access_token: parsed.access_token,
                token_type: (parsed.token_type as string) || 'Bearer',
                browser_info: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
              };
            } catch (error) {
              return {
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        });

        if (!results || !results.length) {
          return { error: 'No script execution result.' };
        }
        return (results[0] as { result: Record<string, unknown> }).result || { error: 'Empty script result.' };
      } catch (scriptError) {
        return { error: 'Script injection not available: ' + String((scriptError as Error).message || scriptError) };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // MAIN-world studies fetch (runs inside the open Prolific tab)
    // ─────────────────────────────────────────────────────────────

    async function fetchStudiesInTab(tabId: number): Promise<Record<string, unknown>> {
      // Prefer scripting mode: the request runs inside the Prolific tab's context,
      // so it carries normal cookies/origin and is indistinguishable from the web
      // app's own API calls. Fall back to background fetch only if scripting fails
      // (tab navigating, dead context, etc.).
      extensionFetchInProgress = true;
      try {
        const scriptResult = await fetchStudiesInTabViaScripting(tabId);
        if (scriptResult.ok) return scriptResult;

        // Scripting failed — try background fetch with stored token
        const existing = await browser.storage.local.get(STATE_KEY);
        const state = (existing[STATE_KEY] as Record<string, unknown>) || {};
        const accessToken = state.access_token as string | undefined;
        const tokenType = (state.token_type as string) || 'Bearer';

        if (!accessToken) {
          return scriptResult;
        }

        pushDebugLog('refresh.fetch_fallback_to_background', {
          scripting_error: scriptResult.error as string,
          tab_id: tabId,
        });

        try {
          const resp = await fetch(FETCH_STUDIES_API_URL, {
            method: 'GET',
            credentials: 'omit',
            headers: {
              'Authorization': tokenType + ' ' + accessToken,
              'Accept': 'application/json, text/plain, */*',
            },
          });
          const body = await resp.text();
          return { ok: true, status_code: resp.status, body };
        } catch (err) {
          return { ok: false, error: 'fetch_failed: ' + String(err) };
        }
      } finally {
        // Small delay before clearing — ensures webRequest.onCompleted (which fires
        // asynchronously) still sees the flag for this request.
        setTimeout(() => { extensionFetchInProgress = false; }, 1000);
      }
    }

    async function fetchStudiesInTabViaScripting(tabId: number): Promise<Record<string, unknown>> {
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: (apiURL: string) => {
            try {
              let oidcKey: string | null = null;
              for (let i = 0; i < window.localStorage.length; i += 1) {
                const key = window.localStorage.key(i);
                if (key && key.startsWith('oidc.user')) {
                  oidcKey = key;
                  break;
                }
              }
              if (!oidcKey) {
                return { ok: false, error: 'no_oidc_token' };
              }
              const raw = window.localStorage.getItem(oidcKey);
              if (!raw) {
                return { ok: false, error: 'empty_oidc_value' };
              }
              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(raw);
              } catch {
                return { ok: false, error: 'invalid_oidc_json' };
              }
              if (!parsed || !parsed.access_token) {
                return { ok: false, error: 'missing_access_token' };
              }

              const tokenType = (parsed.token_type as string) || 'Bearer';
              // Use XHR to match Prolific's own request pattern
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (window as any).__pp_ext_fetch = true;
              return new Promise<Record<string, unknown>>((resolve) => {
                const xhr = new XMLHttpRequest();
                xhr.open('GET', apiURL, true);
                xhr.setRequestHeader('Authorization', tokenType + ' ' + (parsed.access_token as string));
                xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
                xhr.onload = () => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (window as any).__pp_ext_fetch = false;
                  resolve({ ok: true, status_code: xhr.status, body: xhr.responseText });
                };
                xhr.onerror = () => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (window as any).__pp_ext_fetch = false;
                  resolve({ ok: false, error: 'xhr_failed' });
                };
                xhr.send();
              });
            } catch (err) {
              return { ok: false, error: String(err) };
            }
          },
          args: [FETCH_STUDIES_API_URL],
        });

        if (!results || !results.length || !(results[0] as { result: unknown }).result) {
          return { ok: false, error: 'no_script_result' };
        }
        return (results[0] as { result: Record<string, unknown> }).result;
      } catch (scriptError) {
        return { ok: false, error: 'script_injection_failed: ' + String((scriptError as Error).message || scriptError) };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Delayed refresh scheduling (ported from auto_refresh.go)
    // ─────────────────────────────────────────────────────────────

    function planDelayedRefreshCount(policy: Record<string, number>): number {
      const maxByMinimum = Math.floor(policy.cycle_seconds / policy.minimum_delay_seconds) - 1;
      const maxByAverage = Math.floor(policy.cycle_seconds / policy.average_delay_seconds) - 1;
      const count = Math.min(maxByMinimum, maxByAverage);
      return count < 0 ? 0 : count;
    }

    function planDelayedRefreshSchedule(policy: Record<string, number>): number[] {
      const count = planDelayedRefreshCount(policy);
      if (count <= 0) return [];

      const cycleSeconds = policy.cycle_seconds;
      const minGapSeconds = policy.minimum_delay_seconds;
      const spreadSeconds = policy.spread_seconds;
      const segments = count + 1;

      const centers: number[] = [];
      for (let i = 0; i < count; i++) {
        centers.push((cycleSeconds * (i + 1)) / segments);
      }

      const lows = new Array<number>(count);
      const highs = new Array<number>(count);
      for (let i = 0; i < count; i++) {
        let low = centers[i] - spreadSeconds;
        let high = centers[i] + spreadSeconds;
        const minByBoundary = (i + 1) * minGapSeconds;
        const maxByBoundary = cycleSeconds - (count - i) * minGapSeconds;
        if (low < minByBoundary) low = minByBoundary;
        if (high > maxByBoundary) high = maxByBoundary;
        lows[i] = low;
        highs[i] = high;
      }

      for (let i = 1; i < count; i++) {
        const minAllowed = lows[i - 1] + minGapSeconds;
        if (lows[i] < minAllowed) lows[i] = minAllowed;
      }
      for (let i = count - 2; i >= 0; i--) {
        const maxAllowed = highs[i + 1] - minGapSeconds;
        if (highs[i] > maxAllowed) highs[i] = maxAllowed;
      }

      for (let i = 0; i < count; i++) {
        if (lows[i] > highs[i]) {
          return centers.map((c) => c * 1000);
        }
      }

      const chosen = new Array<number>(count);
      for (let i = 0; i < count; i++) {
        let low = lows[i];
        if (i > 0) {
          const minAllowed = chosen[i - 1] + minGapSeconds;
          if (low < minAllowed) low = minAllowed;
        }
        const high = highs[i];
        if (low > high) low = high;
        if (high <= low) {
          chosen[i] = low;
          continue;
        }

        let lowInt = Math.ceil(low);
        const highInt = Math.floor(high);
        if (lowInt > highInt) {
          chosen[i] = low;
          continue;
        }
        if (i > 0) {
          const prevFloor = Math.floor(chosen[i - 1]);
          const minAllowedInt = prevFloor + policy.minimum_delay_seconds;
          if (lowInt < minAllowedInt) lowInt = minAllowedInt;
          if (lowInt > highInt) {
            chosen[i] = highInt;
            continue;
          }
        }
        const span = highInt - lowInt + 1;
        let pick = lowInt;
        if (span > 1) {
          let offset = Math.floor(Math.random() * span);
          if (offset < 0) offset = 0;
          if (offset >= span) offset = span - 1;
          pick = lowInt + offset;
        }
        chosen[i] = pick;
      }

      return chosen.map((s) => s * 1000);
    }

    function cancelDelayedRefreshes(reason: string): void {
      delayedRefreshGeneration++;
      for (const timer of delayedRefreshTimers) {
        clearTimeout(timer);
      }
      delayedRefreshTimers = [];
      pushDebugLog('refresh.delayed.cleared', { reason, generation: delayedRefreshGeneration });
    }

    function isRateLimited(): boolean {
      return rateLimitCooldownUntilMS > 0 && Date.now() < rateLimitCooldownUntilMS;
    }

    function parseRetryAfterSeconds(body: unknown): number {
      // Try to extract retry-after from Prolific's 429 JSON body:
      // {"error":{"detail":"...Expected available in 263 seconds."}}
      try {
        const detail = (body as any)?.error?.detail;
        if (typeof detail === 'string') {
          const match = detail.match(/available in (\d+) seconds/i);
          if (match) return Math.max(1, Number(match[1]));
        }
      } catch {}
      return 300; // default 5 minutes
    }

    async function handleRateLimit(statusCode: number, body: unknown, trigger: string): Promise<void> {
      if (statusCode !== 429) return;

      const retrySeconds = parseRetryAfterSeconds(body);
      const cooldownMS = retrySeconds * 1000 + 5000; // add 5s buffer
      rateLimitCooldownUntilMS = Date.now() + cooldownMS;

      cancelDelayedRefreshes('rate_limit:429');

      await setState({
        studies_refresh_ok: false,
        studies_refresh_reason: `Rate limited. Resuming in ~${retrySeconds}s.`,
      });
      pushDebugLog('refresh.rate_limited', {
        trigger,
        retry_after_seconds: retrySeconds,
        cooldown_until: new Date(rateLimitCooldownUntilMS).toISOString(),
      });

      // Schedule a Prolific tab reload after cooldown to restart the refresh cycle
      if (rateLimitReloadTimer) clearTimeout(rateLimitReloadTimer);
      rateLimitReloadTimer = setTimeout(async () => {
        rateLimitReloadTimer = null;
        rateLimitCooldownUntilMS = 0;
        try {
          const tabs = await queryProlificTabs();
          if (tabs.length && typeof tabs[0].id === 'number') {
            await browser.tabs.reload(tabs[0].id);
            pushDebugLog('refresh.rate_limit_recovery.tab_reloaded', { tab_id: tabs[0].id });
          }
        } catch (err) {
          pushDebugLog('refresh.rate_limit_recovery.error', { error: stringifyError(err) });
        }
      }, cooldownMS);
    }

    // ─────────────────────────────────────────────────────────────
    // Refresh-health tracking & recovery (issue #25)
    // ─────────────────────────────────────────────────────────────

    // Fold a refresh outcome into the health tracker and mirror it into the popup-facing state. A
    // clean 200 clears the error line; a run of failures at/above the threshold raises a persistent
    // "it stopped updating" recovery message. Auth and rate-limit failures keep their own messaging
    // (set by handleAuthExpiry / handleRateLimit), so we don't stomp it with the generic line.
    async function recordRefreshOutcome(
      outcome: RefreshOutcome,
      opts: { reason?: string; extra?: Record<string, unknown> } = {},
    ): Promise<RefreshHealthSnapshot> {
      const snap = refreshHealth.record(outcome);
      const patch: Record<string, unknown> = {
        studies_refresh_consecutive_failures: snap.consecutiveFailures,
        studies_refresh_last_outcome: outcome,
        studies_refresh_recovery_active: snap.persistentlyFailing,
      };
      if (outcome === 'ok') {
        patch.studies_refresh_ok = true;
        patch.studies_refresh_reason = '';
        patch.studies_refresh_last_at = nowIso();
      } else {
        patch.studies_refresh_ok = false;
        if (outcome !== 'auth_expired' && outcome !== 'rate_limited') {
          patch.studies_refresh_reason = snap.persistentlyFailing
            ? REFRESH_PERSISTENT_FAILURE_MESSAGE
            : (opts.reason || 'Studies refresh failed.');
        }
      }
      // Let callers fold their own fields into this single write (e.g. the capture-status fields on
      // the passive-ingest hot path) instead of issuing a second serialized storage round-trip.
      if (opts.extra) Object.assign(patch, opts.extra);
      await setState(patch);
      return snap;
    }

    async function tryReloadProlificTab(trigger: string): Promise<boolean> {
      try {
        const tabs = await queryProlificTabs();
        if (tabs.length && typeof tabs[0].id === 'number') {
          await browser.tabs.reload(tabs[0].id);
          pushDebugLog('refresh.auth_expired.tab_reloaded', { trigger, tab_id: tabs[0].id });
          return true;
        }
      } catch (err) {
        pushDebugLog('refresh.auth_expired.tab_reload_error', { trigger, error: stringifyError(err) });
      }
      return false;
    }

    // Handle a 401 on a studies refresh: stop our own fetches immediately (a dead token would just
    // 401 repeatedly), then escalate recovery by how many consecutive auth failures we've seen —
    // re-read the token, force the tab to silent-renew, or finally ask the user to log in.
    async function handleAuthExpiry(statusCode: number, trigger: string): Promise<void> {
      cancelDelayedRefreshes(`auth_expired:${statusCode}`);
      authExpiryPauseActive = true;

      const snap = await recordRefreshOutcome('auth_expired');
      const action = decideAuthRecoveryAction(snap.consecutiveAuthFailures, {
        resyncMax: AUTH_EXPIRY_RESYNC_MAX_ATTEMPTS,
        reloadMax: AUTH_EXPIRY_RELOAD_MAX_ATTEMPTS,
      });
      pushDebugLog('refresh.auth_expired', {
        trigger,
        status_code: statusCode,
        consecutive_auth_failures: snap.consecutiveAuthFailures,
        action,
      });

      if (action === 'require_auth') {
        // We've exhausted automatic recovery. Surface a clear "log in" line via the refresh channel and
        // stop actively retrying — but do NOT force token_auth_required here. syncTokenOnce (which reads
        // the actual tab) is the authority on sign-in status; forcing it would flip-flop against the
        // ~1/min token re-sync whenever a still-valid-looking token lingers, oscillating the popup
        // between "signed out" and "connected". When the user is genuinely signed out, syncTokenOnce
        // raises the signed-out state itself.
        await setState({ studies_refresh_ok: false, studies_refresh_reason: AUTH_REQUIRED_MESSAGE });
        pushDebugLog('refresh.auth_expired.require_auth', { trigger });
        return;
      }

      await setState({ studies_refresh_ok: false, studies_refresh_reason: REFRESH_RECONNECTING_MESSAGE });

      // A tab reload triggers a fresh OIDC flow; tabs.onUpdated('complete') then re-syncs and resumes
      // us via resumeRefreshesAfterAuthRecovery — so we only fall back to an inline resync if there
      // was no tab to reload (or the reload failed).
      if (action === 'reload_tab' && await tryReloadProlificTab(trigger)) {
        return;
      }
      await requestTokenSync(`${trigger}.auth_expired`);
    }

    // Called from the token-sync success path: if we paused for an expired token and the token is now
    // valid again, clear the pause and reschedule so refreshes resume. Health resets to healthy only
    // once a real 200 lands (via recordRefreshOutcome), so a still-broken token re-escalates cleanly.
    async function resumeRefreshesAfterAuthRecovery(trigger: string): Promise<void> {
      if (!authExpiryPauseActive) return;
      authExpiryPauseActive = false;
      pushDebugLog('refresh.auth_recovered', { trigger });
      try {
        const policy = await getStudiesRefreshPolicySettings();
        scheduleDelayedRefreshes(`${trigger}.auth_recovered`, policy);
      } catch (err) {
        pushDebugLog('refresh.auth_recovered.schedule_error', { trigger, error: stringifyError(err) });
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Storage-quota watchdog (issue #25)
    // ─────────────────────────────────────────────────────────────

    async function readStorageEstimate(): Promise<StorageEstimateInput | null> {
      try {
        const nav = (globalThis as unknown as {
          navigator?: { storage?: { estimate?: () => Promise<StorageEstimateInput> } };
        }).navigator;
        if (!nav?.storage?.estimate) return null;
        // classifyStoragePressure owns all the finite/non-negative coercion, so return the raw estimate.
        return await nav.storage.estimate();
      } catch {
        return null;
      }
    }

    // Watch IndexedDB usage and shed old history before writes start failing. `warn` compacts (cheap,
    // keeps the analytics window); `critical` (or a forced emergency after a real QuotaExceededError)
    // additionally hard-caps the raw row count. Surfaces usage/pressure into state for diagnostics.
    async function checkStorageQuota(trigger: string, opts: { forceEmergency?: boolean } = {}): Promise<void> {
      if (storageCheckInFlight) {
        // Don't silently drop an emergency (e.g. a real QuotaExceededError) just because a routine
        // check is mid-flight — a routine `warn` pass only does age/redundancy compaction, not the
        // row-cap backstop. Remember it and run it as soon as the in-flight pass finishes.
        if (opts.forceEmergency) pendingEmergencyPrune = true;
        return;
      }
      storageCheckInFlight = true;
      try {
        const estimate = await readStorageEstimate();
        const pressure = classifyStoragePressure(estimate, {
          warnRatio: STORAGE_PRESSURE_WARN_RATIO,
          criticalRatio: STORAGE_PRESSURE_CRITICAL_RATIO,
        });
        const emergency = pressure.level === 'critical' || opts.forceEmergency === true;

        let deleted = 0;
        if (emergency || pressure.level === 'warn') {
          try {
            deleted += await store.pruneStudyHistory();
          } catch (err) {
            pushDebugLog('storage.prune.error', { trigger, error: stringifyError(err) });
          }
        }
        if (emergency) {
          try {
            deleted += await store.pruneStudyHistoryToRowCap(STUDY_HISTORY_CRITICAL_ROW_CAP);
          } catch (err) {
            pushDebugLog('storage.rowcap_prune.error', { trigger, error: stringifyError(err) });
          }
        }

        const patch: Record<string, unknown> = {
          storage_bytes_used: pressure.usage,
          storage_quota_bytes: pressure.quota,
          storage_usage_ratio: pressure.ratio,
          storage_pressure: pressure.level,
          storage_checked_at: nowIso(),
        };
        if (deleted > 0) {
          patch.storage_last_prune_at = nowIso();
          patch.storage_last_prune_deleted = deleted;
        }
        await setState(patch);
        pushDebugLog('storage.quota_check', {
          trigger,
          level: pressure.level,
          ratio: Number(pressure.ratio.toFixed(3)),
          usage: pressure.usage,
          quota: pressure.quota,
          deleted,
        });
      } finally {
        storageCheckInFlight = false;
        if (pendingEmergencyPrune) {
          pendingEmergencyPrune = false;
          void checkStorageQuota('quota_error.deferred', { forceEmergency: true });
        }
      }
    }

    // A studies write that fails with a quota error means we're already at the wall — prune now rather
    // than letting the failure be swallowed. Forces the emergency path even if estimate() is missing.
    function handlePossibleQuotaError(error: unknown, source: string): void {
      if (!isQuotaError(error)) return;
      pushDebugLog('storage.quota_exceeded', { source });
      void checkStorageQuota('quota_error', { forceEmergency: true });
    }

    async function runDelayedRefresh(triggerSource: string, generation: number, runIndex: number, runTotal: number): Promise<void> {
      if (generation !== delayedRefreshGeneration) return;
      if (isRateLimited()) {
        pushDebugLog('refresh.delayed.skip_rate_limited', { trigger_source: triggerSource, run_index: runIndex });
        return;
      }
      if (authExpiryPauseActive) {
        pushDebugLog('refresh.delayed.skip_auth_paused', { trigger_source: triggerSource, run_index: runIndex });
        return;
      }
      // Skip if the Prolific tab just fetched recently — avoids near-duplicate requests
      const sinceLast = Date.now() - lastInterceptedResponseAtMS;
      if (lastInterceptedResponseAtMS > 0 && sinceLast < DEDUP_WINDOW_MS) {
        pushDebugLog('refresh.delayed.skip_recent_intercept', {
          trigger_source: triggerSource,
          run_index: runIndex,
          since_last_ms: sinceLast,
        });
        return;
      }

      const tabs = await queryProlificTabs();
      if (!tabs.length) {
        pushDebugLog('refresh.delayed.skip_no_tab', { trigger_source: triggerSource, run_index: runIndex });
        return;
      }

      const tabId = tabs[0].id;
      pushDebugLog('refresh.delayed.fetch_start', {
        trigger_source: triggerSource,
        run_index: runIndex,
        run_total: runTotal,
        tab_id: tabId,
      });

      const result = await fetchStudiesInTab(tabId!);
      if (!result.ok) {
        pushDebugLog('refresh.delayed.fetch_failed', {
          trigger_source: triggerSource,
          run_index: runIndex,
          error: result.error as string,
        });
        await recordRefreshOutcome('network_error', {
          reason: 'Could not reach Prolific to refresh studies.',
        });
        return;
      }

      const observedAt = nowIso();
      const normalizedURL = FETCH_STUDIES_API_URL;

      if (result.status_code === 200) {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(result.body as string);
        } catch (parseErr) {
          pushDebugLog('refresh.delayed.body_parse_error', {
            trigger_source: triggerSource,
            run_index: runIndex,
            error: String(parseErr),
          });
        }

        if (parsedBody) {
          try {
            await ingestStudiesResponse(
              parsedBody,
              observedAt,
              'extension.delayed_refresh',
              normalizedURL,
              result.status_code,
            );
            notifyPopupDashboardUpdated('delayed_refresh', observedAt);
            await recordRefreshOutcome('ok');
          } catch (err) {
            pushDebugLog('refresh.delayed.ingest_error', {
              trigger_source: triggerSource,
              run_index: runIndex,
              error: stringifyError(err),
            });
            handlePossibleQuotaError(err, 'delayed_refresh.ingest');
            // A 200 we couldn't store still means the feed didn't update — count it as a failure so a
            // persistent ingest problem (the only health signal on Chrome's active-fetch path, which
            // has no filterResponseData capture) still flips the persistent-failure state.
            await recordRefreshOutcome('server_error', { reason: 'Studies update could not be saved.' });
          }

          const snapshotEvent = toFullSnapshotEvent(parsedBody, {
            normalizedURL,
            observedAt,
          }, nowIso);
          if (snapshotEvent) {
            queuePrioritySnapshotEvent(snapshotEvent);
          }
        } else {
          // 200 but the body didn't parse — the feed didn't actually update, so count it as a failure
          // rather than leaving the health state untouched.
          await recordRefreshOutcome('server_error', { reason: 'Studies response could not be read.' });
        }
      } else {
        try {
          await store.setStudiesRefresh({
            observed_at: observedAt,
            source: 'extension.delayed_refresh',
            url: normalizedURL,
            status_code: result.status_code as number,
          });
        } catch (err) {
          pushDebugLog('refresh.delayed.set_refresh_error', {
            trigger_source: triggerSource,
            run_index: runIndex,
            error: stringifyError(err),
          });
        }

        // Token expired mid-session — recover proactively instead of silently failing until next cycle.
        if (result.status_code === 401) {
          await handleAuthExpiry(401, 'extension.delayed_refresh');
          return;
        }

        if (result.status_code === 429) {
          let parsedBody: unknown;
          try { parsedBody = JSON.parse(result.body as string); } catch {}
          await handleRateLimit(429, parsedBody, 'extension.delayed_refresh');
          return;
        }

        await recordRefreshOutcome(classifyRefreshStatus(result.status_code as number));
      }

      pushDebugLog('refresh.delayed.completed', {
        trigger_source: triggerSource,
        run_index: runIndex,
        run_total: runTotal,
        status_code: result.status_code,
      });
    }

    function scheduleDelayedRefreshes(triggerSource: string, policy: Record<string, number>): void {
      cancelDelayedRefreshes('reschedule:' + triggerSource);
      const currentGen = delayedRefreshGeneration;
      const delays = planDelayedRefreshSchedule(policy);

      delayedRefreshTimers = delays.map((delayMs, idx) =>
        setTimeout(() => {
          runDelayedRefresh(triggerSource, currentGen, idx + 1, delays.length).catch((err) => {
            pushDebugLog('refresh.delayed.run_error', {
              trigger_source: triggerSource,
              run_index: idx + 1,
              error: stringifyError(err),
            });
          });
        }, delayMs),
      );

      const fireTimes = delays.map((ms) => new Date(Date.now() + ms).toISOString());
      pushDebugLog('refresh.delayed.schedule', {
        trigger_source: triggerSource,
        count: delays.length,
        policy,
        fire_at: fireTimes,
      });
    }

    // ─────────────────────────────────────────────────────────────
    // Offscreen document for audio playback (Chrome service worker)
    // ─────────────────────────────────────────────────────────────

    let offscreenDocumentCreating: Promise<void> | null = null;

    async function ensureOffscreenDocument(): Promise<boolean> {
      if (!(browser as unknown as Record<string, unknown>).offscreen) return false;

      try {
        const contexts = await (browser.runtime as unknown as { getContexts: (opts: Record<string, unknown>) => Promise<unknown[]> }).getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
        });
        if (contexts && contexts.length > 0) return true;
      } catch {
        // getContexts unavailable — try creating anyway.
      }

      if (offscreenDocumentCreating) {
        await offscreenDocumentCreating;
        return true;
      }

      try {
        offscreenDocumentCreating = (browser as unknown as { offscreen: { createDocument: (opts: Record<string, unknown>) => Promise<void> } }).offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['AUDIO_PLAYBACK'],
          justification: 'Play priority study alert sound',
        });
        await offscreenDocumentCreating;
        return true;
      } catch (err) {
        // "Only a single offscreen document may be created" — already exists.
        if (String(err).includes('single offscreen')) return true;
        pushDebugLog('offscreen.create.error', { error: String(err) });
        return false;
      } finally {
        offscreenDocumentCreating = null;
      }
    }

    async function playAudioViaOffscreen(soundType: string, normalizedVolume: number): Promise<void> {
      const soundPath = PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH[soundType as SoundType];
      if (!soundPath) return;

      const created = await ensureOffscreenDocument();
      if (!created) throw new Error('Could not create offscreen document for audio');

      await browser.runtime.sendMessage({
        action: 'offscreenPlaySound',
        soundPath,
        normalizedVolume,
      });
    }

    // ─────────────────────────────────────────────────────────────
    // Content script intercepted response handling (Chrome)
    // ─────────────────────────────────────────────────────────────

    function handleInterceptedResponse(message: Record<string, unknown>): void {
      const { subtype, url, status, body, observed_at } = message;
      if (subtype === 'studies') {
        processInterceptedJSON(url as string, status as number, body, observed_at as string, CAPTURED_JSON_RESPONSE_OPTIONS.studies);
      } else if (subtype === 'submission') {
        processInterceptedJSON(url as string, status as number, body, observed_at as string, CAPTURED_JSON_RESPONSE_OPTIONS.submission);
      } else if (subtype === 'participant_submissions') {
        processInterceptedJSON(url as string, status as number, body, observed_at as string, CAPTURED_JSON_RESPONSE_OPTIONS.participantSubmissions);
      } else if (subtype === 'oauth_token') {
        handleOAuthTokenPayload(body as Record<string, unknown>, 'content_script_intercept', url as string);
      }
    }

    function processInterceptedJSON(url: string, status: number, body: unknown, observedAt: string, options: CapturedJSONResponseOptions): void {
      const normalizedURL = options.normalizeURL(url);
      if (!normalizedURL) return;

      const context = { normalizedURL, observedAt };

      if (typeof options.onParsed === 'function') {
        Promise.resolve(options.onParsed(body, context)).catch(() => {});
      }

      options.postToService({
        url: normalizedURL,
        status_code: status,
        observed_at: observedAt,
        body: body,
      }).then(() => {
        bumpCounter(options.ingestSuccessCounter, 1);
        pushDebugLog(options.ingestSuccessEvent, { url: normalizedURL });
        options.onIngestSuccess?.(context);
      }).catch((error: unknown) => {
        bumpCounter(options.ingestErrorCounter, 1);
        pushDebugLog(options.ingestErrorEvent, { url: normalizedURL, error: stringifyError(error) });
        options.onIngestError?.(error, context);
      });
    }



    // ─────────────────────────────────────────────────────────────
    // Token sync
    // ─────────────────────────────────────────────────────────────

    async function queryProlificTabs(): Promise<Array<{ id?: number; url?: string }>> {
      const tabs = await browser.tabs.query({ url: PROLIFIC_PATTERNS });
      return Array.isArray(tabs) ? tabs : [];
    }

    // ─────────────────────────────────────────────────────────────
    // Priority actions runtime
    // ─────────────────────────────────────────────────────────────

    const priorityActionsRuntime = createPriorityActions({
      nowIso,
      queryProlificTabs,
      pushDebugLog,
      bumpCounter,
      setState,
      playAudioFn: import.meta.env.CHROME ? playAudioViaOffscreen : undefined,
      limits: {
        minAlertSoundVolume: MIN_PRIORITY_ALERT_SOUND_VOLUME,
        maxAlertSoundVolume: MAX_PRIORITY_ALERT_SOUND_VOLUME,
        defaultAlertSoundVolume: DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
        alertCooldownMS: PRIORITY_ALERT_COOLDOWN_MS,
        maxAutoOpenPerBatch: MAX_PRIORITY_STUDY_AUTO_OPEN_PER_BATCH,
      },
    });

    // ─────────────────────────────────────────────────────────────
    // Priority processing pipeline
    // ─────────────────────────────────────────────────────────────

    async function handlePriorityAlertAction(filter: PriorityFilter, matchingStudies: Study[], trigger: string): Promise<void> {
      const candidateStudies = priorityStateRuntime.selectAlertCandidates(matchingStudies);
      if (!candidateStudies.length) {
        return;
      }
      priorityStateRuntime.markAlertSeen(candidateStudies);
      await priorityActionsRuntime.handleAlertAction(filter, candidateStudies, trigger);
    }

    async function handlePriorityAutoOpenAction(filter: PriorityFilter, matchingStudies: Study[], trigger: string): Promise<void> {
      const candidateStudies = priorityStateRuntime.selectAutoOpenCandidates(matchingStudies);
      if (!candidateStudies.length) {
        return;
      }
      priorityStateRuntime.markAutoOpenSeen(candidateStudies);
      await priorityActionsRuntime.handleAutoOpenAction(filter, candidateStudies, trigger);
    }

    let cachedTelegramSettings: TelegramSettings | null = null;

    async function refreshTelegramSettingsCache(): Promise<TelegramSettings> {
      cachedTelegramSettings = await loadTelegramSettings();
      return cachedTelegramSettings;
    }

    async function sendStudyTelegramMessage(
      rawStudy: Study,
      filter: PriorityFilter | null,
      settings: TelegramSettings,
    ): Promise<boolean> {
      // Studies from the priority pipeline are raw API objects (not normalized).
      const study = normalizeStudy(rawStudy as unknown as Record<string, unknown>);
      const result = await sendTelegramMessage(
        settings.bot_token, settings.chat_id,
        formatTelegramMessage(study, filter, settings.message_format),
        settings.silent_notifications,
        buildStudyReplyMarkup(study, settings.message_format),
      );
      if (result.ok) {
        pushDebugLog('telegram.notify.sent', { study: study.name || study.id, filter: filter?.name });
      } else {
        pushDebugLog('telegram.notify.error', { study: study.name || study.id, filter: filter?.name, error: result.description || result.error });
      }
      return result.ok;
    }

    function queuePrioritySnapshotEvent(rawEvent: unknown): void {
      priorityStateRuntime.queueEvent(rawEvent, processPrioritySnapshotEvent);
    }

    async function processPrioritySnapshotEvent(event: NormalizedSnapshotEvent): Promise<void> {
      await priorityStateRuntime.ensureHydrated();

      // When studies disappear, clear alert suppression for any the user attempted
      // (clicked "Take part"). This way if the study reappears with new places,
      // the user gets a fresh alert and auto-open.
      if (event.mode === 'delta' && event.removedStudyIDs.length) {
        priorityStateRuntime.clearSeenForAttemptedStudies(event.removedStudyIDs);
      }

      const filters = await getPriorityFilters();
      const evaluation = evaluatePrioritySnapshotEvent(priorityStateRuntime.getSnapshot(), event, filters);
      priorityStateRuntime.setSnapshot(evaluation.nextSnapshot);
      await priorityStateRuntime.persistSnapshot(evaluation.nextSnapshot, evaluation.event.observedAtMS);

      if (evaluation.isBaseline) {
        pushDebugLog('tab.priority_auto_open.baseline', {
          trigger: evaluation.event.trigger,
          available_count: evaluation.nextSnapshot.knownStudyIDs.size,
        });
        return;
      }

      if (!evaluation.newlySeenStudies.length) {
        return;
      }

      const telegramSettings = cachedTelegramSettings;
      const tgActive = telegramSettings && isTelegramConfigured(telegramSettings);

      // Single pass: build per-study filter map, collect telegram studies,
      // and gather priority action promises.
      const studyFilterMap = new Map<string, PriorityFilter>();
      let anyFilterNotify = false;
      const tgNotifyStudies: Study[] = [];
      const priorityActionPromises: Promise<void>[] = [];
      for (const { filter } of evaluation.enabledFilters) {
        const matched = evaluation.matchesByFilterId.get(filter.id);
        if (!matched?.length) continue;
        for (const study of matched) studyFilterMap.set(study.id, filter);
        if (filter.telegram_notify) {
          anyFilterNotify = true;
          tgNotifyStudies.push(...matched);
        }
        priorityActionPromises.push(
          handlePriorityAlertAction(filter, matched, evaluation.event.trigger),
          handlePriorityAutoOpenAction(filter, matched, evaluation.event.trigger),
        );
      }
      if (!evaluation.enabledFilters.length) {
        pushDebugLog('tab.priority_auto_open.disabled', {
          trigger: evaluation.event.trigger,
          candidate_count: evaluation.newlySeenStudies.length,
        });
      }

      const priorityActionsTask = Promise.all(priorityActionPromises);

      const telegramTask = (async () => {
        if (!tgActive) return;
        const shouldNotify = telegramSettings.notify_all_studies || anyFilterNotify;
        if (!shouldNotify) return;

        // Filter-matched studies always notify. Non-filter studies (notify_all)
        // are subject to a 1-hour cooldown to avoid spam from studies that
        // briefly disappear and reappear.
        let tgStudies: Study[];
        if (telegramSettings.notify_all_studies) {
          const filterMatchedIDs = new Set(tgNotifyStudies.map((s) => s.id));
          const nonFilterStudies = evaluation.newlySeenStudies.filter((s) => !filterMatchedIDs.has(s.id));
          const dedupedNonFilter = priorityStateRuntime.selectTelegramCandidates(nonFilterStudies);
          tgStudies = [...tgNotifyStudies, ...dedupedNonFilter];
        } else {
          tgStudies = tgNotifyStudies;
        }
        if (!tgStudies.length) return;

        priorityStateRuntime.markTelegramSeen(tgStudies);

        const results = await Promise.all(
          tgStudies.map((study) =>
            sendStudyTelegramMessage(study, studyFilterMap.get(study.id) ?? null, telegramSettings)
              .catch((err: unknown) => { pushDebugLog('telegram.notify.error', { error: toUserErrorMessage(err) }); return false as const; }),
          ),
        );
        const sentCount = results.filter(Boolean).length;
        if (sentCount) {
          await updateState((prev) => ({
            priority_telegram_notify_count: (Number(prev.priority_telegram_notify_count) || 0) + sentCount,
            telegram_notify_last_at: nowIso(),
            telegram_notify_last_trigger: evaluation.event.trigger,
          }));
        }
      })();

      await Promise.all([priorityActionsTask, telegramTask]);
    }

    // ─────────────────────────────────────────────────────────────
    // Auto-open Prolific tab
    // ─────────────────────────────────────────────────────────────

    async function hasTrackedAutoOpenedTab(): Promise<boolean> {
      if (typeof lastAutoOpenedTabId !== 'number') {
        return false;
      }
      try {
        const trackedTab = await browser.tabs.get(lastAutoOpenedTabId);
        return Boolean(trackedTab);
      } catch {
        lastAutoOpenedTabId = null;
        return false;
      }
    }

    async function setMissingProlificTabState(trigger: string, reason: string, autoOpenEnabled: boolean): Promise<void> {
      await setTokenSyncState({
        ok: false,
        authRequired: false,
        trigger,
        reason,
        extra: {
          token_key: '',
          token_origin: '',
        },
      });

      const patch: Record<string, unknown> = { auto_open_enabled: autoOpenEnabled };
      if (autoOpenEnabled) {
        patch.auto_open_last_opened_at = nowIso();
      }
      await setState(patch);
    }

    async function maybeAutoOpenProlificTab(trigger: string, knownProlificTabs?: Array<{ id?: number; url?: string }>): Promise<boolean> {
      const stored = await browser.storage.local.get([AUTO_OPEN_PROLIFIC_TAB_KEY]);
      const autoOpenEnabled = stored[AUTO_OPEN_PROLIFIC_TAB_KEY] !== false;

      if (!autoOpenEnabled) {
        await setMissingProlificTabState(
          trigger,
          'No open Prolific tab found and auto-open is disabled.',
          false,
        );
        pushDebugLog('tab.auto_open.disabled', { trigger });
        return false;
      }

      // Dedupe strategy: allow only one open in-flight, and do not auto-open
      // again while the last auto-opened tab still exists.
      if (autoOpenInFlight) {
        pushDebugLog('tab.auto_open.dedup_skip', {
          trigger,
          in_flight: true,
        });
        return false;
      }

      if (await hasTrackedAutoOpenedTab()) {
        pushDebugLog('tab.auto_open.dedup_skip', {
          trigger,
          in_flight: false,
          last_tab_id: lastAutoOpenedTabId,
        });
        return false;
      }

      const existingTabs = Array.isArray(knownProlificTabs) ? knownProlificTabs : await queryProlificTabs();
      if (existingTabs.length > 0) {
        pushDebugLog('tab.auto_open.skip_existing_tab', {
          trigger,
          count: existingTabs.length,
        });
        return false;
      }

      autoOpenInFlight = true;
      try {
        const createdTab = await browser.tabs.create({
          url: PROLIFIC_STUDIES_URL,
          active: false,
        });
        if (createdTab && typeof createdTab.id === 'number') {
          lastAutoOpenedTabId = createdTab.id;
          try {
            await browser.tabs.update(createdTab.id, { pinned: true });
          } catch {
            // Best effort.
          }
        }
      } finally {
        autoOpenInFlight = false;
      }

      await setMissingProlificTabState(
        trigger,
        'No open Prolific tab found. Opened one automatically.',
        true,
      );
      bumpCounter('tab_auto_open_count', 1);
      pushDebugLog('tab.auto_open.created', { trigger });

      return true;
    }

    // ─────────────────────────────────────────────────────────────
    // Token sync
    // ─────────────────────────────────────────────────────────────

    function normalizeSyncTrigger(trigger: unknown): string {
      const normalized = typeof trigger === 'string' ? trigger.trim() : '';
      return normalized || 'unknown';
    }

    function queuePendingTokenSync(trigger: string): void {
      const normalizedTrigger = normalizeSyncTrigger(trigger);
      pendingSyncTrigger = normalizedTrigger;
      pushDebugLog('token.sync.skip_in_progress', { trigger: normalizedTrigger });
    }

    function drainPendingTokenSync(): void {
      if (!pendingSyncTrigger) {
        return;
      }

      const queuedTrigger = pendingSyncTrigger;
      pendingSyncTrigger = '';
      Promise.resolve().then(() => {
        requestTokenSync(`${queuedTrigger}.queued`);
      });
    }

    function requestTokenSync(trigger: string): Promise<void> {
      return syncTokenOnce(normalizeSyncTrigger(trigger));
    }

    async function syncTokenOnce(trigger: string): Promise<void> {
      const normalizedTrigger = normalizeSyncTrigger(trigger);

      if (syncInProgress) {
        queuePendingTokenSync(normalizedTrigger);
        return;
      }
      syncInProgress = true;
      pushDebugLog('token.sync.start', { trigger: normalizedTrigger });

      try {
        const tabs = await queryProlificTabs();
        if (!tabs.length) {
          await maybeAutoOpenProlificTab(normalizedTrigger, tabs);
          return;
        }

        let extracted: Record<string, unknown> | null = null;
        let anyTabAccessible = false;
        for (const tab of tabs) {
          try {
            const result = await extractTokenFromTab(tab.id!);
            if (result && result.access_token) {
              extracted = result;
              break;
            }
            // Script ran in the tab but found no token — tab was accessible.
            // Distinguish from injection failures (page loading, dead context)
            // where the error contains "Script injection not available".
            if (result && result.error &&
                !String(result.error).includes('Script injection not available') &&
                !String(result.error).includes('No script execution result') &&
                !String(result.error).includes('Empty script result')) {
              anyTabAccessible = true;
            }
          } catch (tabError) {
            await setTokenSyncState({
              ok: false,
              authRequired: false,
              trigger: normalizedTrigger,
              reason: `Failed to inspect tab ${tab.id}: ${(tabError as Error).message}`,
            });
          }
        }

        if (!extracted) {
          // Only cancel delayed refreshes if we confirmed the user is actually
          // signed out (script ran in a tab but found no OIDC token). Transient
          // failures (tab loading, script injection unavailable) should not kill
          // pending refreshes — they'll recover once the tab is ready.
          if (anyTabAccessible) {
            cancelDelayedRefreshes('token_cleared');
          }
          pushDebugLog('token.cleared_local', { trigger: normalizedTrigger, reason: 'extension.no_oidc_user_token', tab_accessible: anyTabAccessible });

          await setTokenSyncState({
            ok: false,
            authRequired: true,
            trigger: normalizedTrigger,
            reason: 'Signed out of Prolific. Log in at app.prolific.com to resume syncing.',
            extra: {
              token_key: '',
              token_origin: '',
            },
          });
          return;
        }

        await setTokenSyncState({
          ok: true,
          authRequired: false,
          trigger: normalizedTrigger,
          reason: 'Token available.',
          extra: {
            token_key: extracted.key as string,
            token_origin: extracted.origin as string,
            token_last_success_at: nowIso(),
            access_token: extracted.access_token as string,
            token_type: (extracted.token_type as string) || 'Bearer',
          },
        });
        bumpCounter('token_sync_success_count', 1);
        pushDebugLog('token.sync.ok', { trigger: normalizedTrigger, tab_origin: extracted.origin as string });
        // If we paused refreshes for an expired token, a fresh valid token means we can resume.
        await resumeRefreshesAfterAuthRecovery(normalizedTrigger);
      } catch (error) {
        await setTokenSyncState({
          ok: false,
          authRequired: false,
          trigger: normalizedTrigger,
          reason: stringifyError(error),
        });
        bumpCounter('token_sync_error_count', 1);
        pushDebugLog('token.sync.error', { trigger: normalizedTrigger, error: stringifyError(error) });
      } finally {
        syncInProgress = false;
        drainPendingTokenSync();
      }
    }

    async function handleOAuthTokenPayload(payload: unknown, trigger: string, originHint: string): Promise<void> {
      const p = payload as Record<string, unknown> | null | undefined;
      if (!p || typeof p !== 'object' || !p.access_token) {
        pushDebugLog('oauth.payload.missing_access_token', { trigger });
        await requestTokenSync(`${trigger}.fallback_resync`);
        return;
      }

      await setTokenSyncState({
        ok: true,
        authRequired: false,
        trigger,
        reason: 'Captured access_token from oauth/token response.',
        extra: {
          token_key: 'oauth.token.response',
          token_origin: originHint || 'https://auth.prolific.com',
          token_last_success_at: nowIso(),
          access_token: p.access_token as string,
          token_type: (p.token_type as string) || 'Bearer',
        },
      });
      bumpCounter('oauth_token_capture_success_count', 1);
      pushDebugLog('oauth.capture.ok', { trigger, origin: originHint || 'https://auth.prolific.com' });
    }

    // ─────────────────────────────────────────────────────────────
    // Firefox webRequest capture (filterResponseData)
    // ─────────────────────────────────────────────────────────────

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function getFilterResponseDataFunction(): ((requestId: string) => any) | null {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = browser as any;
      if (
        b.webRequest &&
        typeof b.webRequest.filterResponseData === 'function'
      ) {
        return b.webRequest.filterResponseData.bind(b.webRequest);
      }

      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function tapOAuthTokenResponse(details: any): void {
      tapFilteredJSONResponse(details, {
        onParsed: (parsed: unknown) => {
          const originHint = details.initiator || details.originUrl || 'https://auth.prolific.com';
          handleOAuthTokenPayload(parsed, 'oauth_token_response', originHint);
        },
        onParseError: () => {
          requestTokenSync('oauth_token_response.parse_failed_resync');
        },
        onFilterError: () => {
          requestTokenSync('oauth_token_response.filter_error_resync');
        },
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function safeDisconnectResponseFilter(filter: any): void {
      try {
        filter.disconnect();
      } catch {
        // ignore
      }
    }

    interface TapFilteredJSONResponseHandlers {
      onStop?: (observedAt: string) => void;
      onParseError?: (error: unknown, observedAt: string) => void;
      onParsed?: (parsed: unknown, observedAt: string) => void;
      onFilterError?: () => void;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function tapFilteredJSONResponse(details: any, handlers: TapFilteredJSONResponseHandlers): boolean {
      const filterResponseData = getFilterResponseDataFunction();
      if (!filterResponseData) {
        return false;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let filter: any;
      try {
        filter = filterResponseData(details.requestId);
      } catch {
        return false;
      }

      const decoder = new TextDecoder('utf-8');
      let bodyText = '';

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filter.ondata = (event: any) => {
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

        try {
          const parsed: unknown = JSON.parse(bodyText);
          handlers.onParsed?.(parsed, observedAt);
        } catch (error) {
          handlers.onParseError?.(error, observedAt);
        }
      };

      filter.onerror = () => {
        safeDisconnectResponseFilter(filter);
        handlers.onFilterError?.();
      };

      return true;
    }

    // ─────────────────────────────────────────────────────────────
    // Captured JSON response options (shared across Firefox/Chrome)
    // ─────────────────────────────────────────────────────────────

    interface CapturedJSONResponseOptions {
      normalizeURL: (raw: string) => string;
      statusCode: number;
      postToService: (payload: Record<string, unknown>) => Promise<void>;
      parseErrorCounter: string;
      parseErrorEvent: string;
      ingestSuccessCounter: string;
      ingestSuccessEvent: string;
      ingestErrorCounter: string;
      ingestErrorEvent: string;
      filterErrorCounter: string;
      filterErrorEvent: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onParsed?: (parsed: unknown, context: any) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onSkip?: (details: any) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onStop?: (context: any) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onParseError?: (error: unknown, context: any) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onIngestSuccess?: (context: any) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onIngestError?: (error: unknown, context: any) => void;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onFilterError?: (context: any) => void;
    }

    function buildCapturedJSONResponseOptions(config: {
      normalizeURL: (raw: string) => string;
      statusCode: number;
      ingestFn: (payload: Record<string, unknown>) => Promise<void>;
      counterPrefix: string;
      eventPrefix: string;
      extraHooks?: Record<string, unknown>;
    }): CapturedJSONResponseOptions {
      return Object.freeze({
        normalizeURL: config.normalizeURL,
        statusCode: config.statusCode,
        postToService: config.ingestFn,
        parseErrorCounter: `${config.counterPrefix}_parse_error_count`,
        parseErrorEvent: `${config.eventPrefix}.parse.error`,
        ingestSuccessCounter: `${config.counterPrefix}_ingest_success_count`,
        ingestSuccessEvent: `${config.eventPrefix}.ingest.ok`,
        ingestErrorCounter: `${config.counterPrefix}_ingest_error_count`,
        ingestErrorEvent: `${config.eventPrefix}.ingest.error`,
        filterErrorCounter: `${config.counterPrefix}_filter_error_count`,
        filterErrorEvent: `${config.eventPrefix}.filter.error`,
        ...(config.extraHooks || {}),
      }) as CapturedJSONResponseOptions;
    }

    const CAPTURED_JSON_RESPONSE_OPTIONS = Object.freeze({
      studies: buildCapturedJSONResponseOptions({
        normalizeURL: normalizeStudiesCollectionURL,
        statusCode: 200,
        ingestFn: async (payload) => {
          await ingestStudiesResponse(
            payload.body,
            payload.observed_at as string,
            'extension.intercepted_response',
            payload.url as string,
            payload.status_code as number,
          );
          notifyPopupDashboardUpdated('studies.response.capture', payload.observed_at as string);
        },
        counterPrefix: 'studies_response',
        eventPrefix: 'studies.response',
        extraHooks: {
          onParsed: (parsed: unknown, context: { normalizedURL: string; observedAt: string }) => {
            const event = toFullSnapshotEvent(parsed, context, nowIso);
            if (event) { queuePrioritySnapshotEvent(event); }
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          onSkip: (details: any) => {
            pushDebugLog('studies.response.capture.skip_non_collection', {
              url: details.url,
              request_id: details.requestId,
            });
          },
          onStop: (context: { normalizedURL: string; details: { requestId: string }; observedAt: string }) => {
            pushDebugLog('studies.response.capture.stop', {
              url: context.normalizedURL,
              request_id: context.details.requestId,
            });
          },
          onParseError: (error: unknown, context: { observedAt: string }) => {
            setState({
              studies_response_capture_ok: false,
              studies_response_capture_reason: `failed to parse studies response JSON: ${String(error)}`,
              studies_response_capture_last_at: context.observedAt,
            });
          },
          onIngestSuccess: (context: { observedAt: string }) => {
            // Single source of truth for refresh health — resets consecutive-failure tracking too.
            // Fold the capture-status fields into that one write (this is the passive-ingest hot path,
            // firing on every tab poll) rather than issuing a second serialized storage round-trip.
            void recordRefreshOutcome('ok', {
              extra: {
                studies_response_capture_ok: true,
                studies_response_capture_reason: '',
                studies_response_capture_last_at: context.observedAt,
              },
            });
          },
          onIngestError: (error: unknown, context: { observedAt: string }) => {
            handlePossibleQuotaError(error, 'response_capture.ingest');
            setState({
              studies_response_capture_ok: false,
              studies_response_capture_reason: stringifyError(error),
              studies_response_capture_last_at: context.observedAt,
            });
          },
          onFilterError: (context: { observedAt: string }) => {
            setState({
              studies_response_capture_ok: false,
              studies_response_capture_reason: 'response stream filter error',
              studies_response_capture_last_at: context.observedAt,
            });
          },
        },
      }),
      submission: buildCapturedJSONResponseOptions({
        normalizeURL: normalizeSubmissionURL,
        statusCode: 0,
        ingestFn: async (payload) => {
          await ingestSubmissionResponse(payload.body, payload.observed_at as string);
        },
        counterPrefix: 'submission_response',
        eventPrefix: 'submission.response',
        extraHooks: {
          onParsed: (parsed: unknown) => {
            // Mark the study as attempted so it re-alerts if it disappears and
            // reappears (e.g., place freed up after "no places available" error).
            const p = parsed as Record<string, unknown> | null;
            const studyID = p && typeof p === 'object'
              ? ((p.study_id as string) || ((p.study as Record<string, unknown>)?.id as string) || '')
              : '';
            if (studyID) {
              priorityStateRuntime.markAttempted(String(studyID).trim());
              pushDebugLog('submission.reserve.study_attempted', { study_id: studyID });
            }
          },
        },
      }),
      participantSubmissions: buildCapturedJSONResponseOptions({
        normalizeURL: normalizeParticipantSubmissionsURL,
        statusCode: 200,
        ingestFn: async (payload) => {
          await ingestParticipantSubmissionsResponse(payload.body, payload.observed_at as string);
        },
        counterPrefix: 'participant_submissions_response',
        eventPrefix: 'participant.submissions.response',
      }),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function tapCapturedJSONResponse(details: any, options: CapturedJSONResponseOptions, normalizedURLOverride: string = ''): void {
      const normalizedURL = normalizedURLOverride || options.normalizeURL(details.url);
      if (!normalizedURL) {
        options.onSkip?.(details);
        return;
      }

      tapFilteredJSONResponse(details, {
        onStop: (observedAt: string) => {
          options.onStop?.({
            details,
            normalizedURL,
            observedAt,
          });
        },
        onParseError: (error: unknown, observedAt: string) => {
          bumpCounter(options.parseErrorCounter, 1);
          pushDebugLog(options.parseErrorEvent, {
            url: normalizedURL,
            error: stringifyError(error),
          });
          options.onParseError?.(error, {
            details,
            normalizedURL,
            observedAt,
          });
        },
        onParsed: (parsed: unknown, observedAt: string) => {
          // Same processing as the content script intercept path.
          processInterceptedJSON(details.url, options.statusCode, parsed, observedAt, options);
        },
        onFilterError: () => {
          const observedAt = nowIso();
          bumpCounter(options.filterErrorCounter, 1);
          pushDebugLog(options.filterErrorEvent, { url: normalizedURL });
          options.onFilterError?.({
            details,
            normalizedURL,
            observedAt,
          });
        },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // Studies request completed handler
    // ─────────────────────────────────────────────────────────────

    async function handleStudiesRequestCompleted(details: { url: string; statusCode?: number; requestId?: string }): Promise<void> {
      if (extensionFetchInProgress) {
        pushDebugLog('studies.request.completed.skip_extension_originated', { url: details.url });
        return;
      }

      const normalizedURL = normalizeStudiesCollectionURL(details.url);
      if (!normalizedURL) {
        await pushDebugLog('studies.request.completed.skip_non_collection', {
          url: details.url,
          status_code: details.statusCode || 0,
        });
        return;
      }

      lastInterceptedResponseAtMS = Date.now();

      const refreshPolicy = await getStudiesRefreshPolicySettings();
      await bumpCounter('studies_request_completed_count', 1);
      await pushDebugLog('studies.request.completed', {
        url: normalizedURL,
        status_code: details.statusCode || 0,
      });

      if (details.statusCode === 200) {
        rateLimitCooldownUntilMS = 0;
        if (rateLimitReloadTimer) { clearTimeout(rateLimitReloadTimer); rateLimitReloadTimer = null; }
        // The Prolific tab's own fetch succeeded, so the session is healthy — lift any auth pause.
        // (The ingest of this same response records the 'ok' outcome that resets failure tracking.)
        authExpiryPauseActive = false;
        scheduleDelayedRefreshes('extension.intercepted_response', refreshPolicy);
      } else if (details.statusCode === 401) {
        await handleAuthExpiry(401, 'intercepted_response');
      } else if (details.statusCode === 429) {
        await handleRateLimit(429, null, 'intercepted_response');
      } else if (typeof details.statusCode === 'number' && details.statusCode >= 400) {
        await recordRefreshOutcome(classifyRefreshStatus(details.statusCode));
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Capture listener registration
    // ─────────────────────────────────────────────────────────────

    function registerStudiesCompletedCapture(): void {
      if (studiesCompletedListenerRegistered) {
        return;
      }
      if (!browser.webRequest || !browser.webRequest.onCompleted) {
        pushDebugLog('studies.completed.listener.unavailable', {});
        return;
      }

      browser.webRequest.onCompleted.addListener(
        (details) => {
          handleStudiesRequestCompleted(details);
        },
        { urls: [STUDIES_REQUEST_PATTERN] },
      );

      studiesCompletedListenerRegistered = true;
      pushDebugLog('studies.completed.listener.registered', {});
    }

    function registerBlockingResponseCapture(options: {
      isRegistered: () => boolean;
      markRegistered: () => void;
      urls: string[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onBeforeRequest: (details: any) => void;
      onUnsupported?: () => void;
      onListenerUnavailable?: () => void;
      onRegistered?: () => void;
      onRegisterError?: (error: unknown) => void;
    }): void {
      if (options.isRegistered()) {
        return;
      }

      if (!getFilterResponseDataFunction()) {
        if (options.onUnsupported) {
          options.onUnsupported();
        }
        return;
      }

      if (!browser.webRequest || !(browser.webRequest as unknown as { onBeforeRequest: unknown }).onBeforeRequest) {
        if (options.onListenerUnavailable) {
          options.onListenerUnavailable();
        }
        return;
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (browser.webRequest as any).onBeforeRequest.addListener(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (details: any) => {
            options.onBeforeRequest(details);
            return {};
          },
          { urls: options.urls },
          ['blocking'],
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

    function registerJSONBodyResponseCapture(options: {
      isRegistered: () => boolean;
      markRegistered: () => void;
      urls: string[];
      normalizeURL: (raw: string) => string;
      beforeRequestCounter: string;
      captureOptions: CapturedJSONResponseOptions;
      unsupportedEvent: string;
      unavailableEvent: string;
      registeredEvent: string;
      registeredDetails?: Record<string, unknown>;
      registerErrorEvent: string;
    }): void {
      registerBlockingResponseCapture({
        isRegistered: options.isRegistered,
        markRegistered: options.markRegistered,
        urls: options.urls,
        onUnsupported: () => {
          pushDebugLog(options.unsupportedEvent, {
            reason: 'filterResponseData not supported',
          });
        },
        onListenerUnavailable: () => {
          pushDebugLog(options.unavailableEvent, {});
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onBeforeRequest: (details: any) => {
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
        onRegisterError: (error: unknown) => {
          pushDebugLog(options.registerErrorEvent, { error: stringifyError(error) });
        },
      });
    }

    function registerStudiesResponseCaptureIfSupported(): void {
      registerBlockingResponseCapture({
        isRegistered: () => studiesResponseCaptureRegistered,
        markRegistered: () => {
          studiesResponseCaptureRegistered = true;
        },
        urls: [STUDIES_REQUEST_PATTERN],
        onUnsupported: () => {
          const manifest = browser.runtime && browser.runtime.getManifest
            ? browser.runtime.getManifest()
            : null;
          const manifestPermissions = manifest && Array.isArray(manifest.permissions) ? manifest.permissions : [];

          setState({
            studies_response_capture_supported: false,
            studies_response_capture_registered: false,
            studies_response_capture_ok: null,
            studies_response_capture_reason: 'filterResponseData not supported',
            studies_response_capture_checked_at: nowIso(),
          });
          pushDebugLog('studies.response.capture.unsupported', {
            reason: 'filterResponseData not supported',
            manifest_version: manifest ? manifest.manifest_version : 'unknown',
            permissions: manifestPermissions,
          });
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onBeforeRequest: (details: any) => {
          if (extensionFetchInProgress) {
            return;
          }
          const normalizedURL = normalizeStudiesCollectionURL(details.url);
          if (!normalizedURL) {
            pushDebugLog('studies.response.capture.before_request.skip_non_collection', {
              url: details.url,
              request_id: details.requestId,
            });
            return;
          }
          bumpCounter('studies_response_before_request_count', 1);
          pushDebugLog('studies.response.capture.before_request', { url: normalizedURL, request_id: details.requestId });
          tapCapturedJSONResponse(details, CAPTURED_JSON_RESPONSE_OPTIONS.studies, normalizedURL);
        },
        onRegistered: () => {
          setState({
            studies_response_capture_supported: true,
            studies_response_capture_registered: true,
            studies_response_capture_ok: null,
            studies_response_capture_reason: '',
            studies_response_capture_checked_at: nowIso(),
          });
          pushDebugLog('studies.response.capture.registered', {});
        },
        onRegisterError: (error: unknown) => {
          setState({
            studies_response_capture_supported: false,
            studies_response_capture_registered: false,
            studies_response_capture_ok: false,
            studies_response_capture_reason: stringifyError(error),
            studies_response_capture_checked_at: nowIso(),
          });
          pushDebugLog('studies.response.capture.register_error', { error: stringifyError(error) });
        },
      });
    }

    function registerSubmissionResponseCaptureIfSupported(): void {
      registerJSONBodyResponseCapture({
        isRegistered: () => submissionResponseCaptureRegistered,
        markRegistered: () => {
          submissionResponseCaptureRegistered = true;
        },
        urls: SUBMISSION_PATTERNS,
        normalizeURL: normalizeSubmissionURL,
        beforeRequestCounter: 'submission_response_before_request_count',
        captureOptions: CAPTURED_JSON_RESPONSE_OPTIONS.submission,
        unsupportedEvent: 'submission.response.capture.unsupported',
        unavailableEvent: 'submission.response.capture.listener.unavailable',
        registeredEvent: 'submission.response.capture.registered',
        registeredDetails: { patterns: SUBMISSION_PATTERNS },
        registerErrorEvent: 'submission.response.capture.register_error',
      });
    }

    function registerParticipantSubmissionsResponseCaptureIfSupported(): void {
      registerJSONBodyResponseCapture({
        isRegistered: () => participantSubmissionsResponseCaptureRegistered,
        markRegistered: () => {
          participantSubmissionsResponseCaptureRegistered = true;
        },
        urls: [PARTICIPANT_SUBMISSIONS_PATTERN],
        normalizeURL: normalizeParticipantSubmissionsURL,
        beforeRequestCounter: 'participant_submissions_response_before_request_count',
        captureOptions: CAPTURED_JSON_RESPONSE_OPTIONS.participantSubmissions,
        unsupportedEvent: 'participant.submissions.response.capture.unsupported',
        unavailableEvent: 'participant.submissions.response.capture.listener.unavailable',
        registeredEvent: 'participant.submissions.response.capture.registered',
        registeredDetails: { patterns: [PARTICIPANT_SUBMISSIONS_PATTERN] },
        registerErrorEvent: 'participant.submissions.response.capture.register_error',
      });
    }

    function registerOAuthCompletedFallbackListener(): void {
      if (oauthCompletedListenerRegistered) {
        return;
      }

      if (!browser.webRequest || !browser.webRequest.onCompleted) {
        pushDebugLog('oauth.completed.listener.unavailable', {});
        return;
      }

      browser.webRequest.onCompleted.addListener(
        () => {
          requestTokenSync('oauth_token_completed_resync');
        },
        { urls: [OAUTH_TOKEN_PATTERN] },
      );

      oauthCompletedListenerRegistered = true;
      pushDebugLog('oauth.completed.listener.registered', {});
    }

    function registerOAuthResponseCaptureIfSupported(): void {
      registerBlockingResponseCapture({
        isRegistered: () => oauthResponseCaptureRegistered,
        markRegistered: () => {
          oauthResponseCaptureRegistered = true;
        },
        urls: [OAUTH_TOKEN_PATTERN],
        onUnsupported: () => {
          pushDebugLog('oauth.response.capture.unsupported', {
            reason: 'filterResponseData not supported',
          });
        },
        onListenerUnavailable: () => {
          pushDebugLog('oauth.response.capture.listener.unavailable', {});
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onBeforeRequest: (details: any) => {
          tapOAuthTokenResponse(details);
        },
        onRegistered: () => {
          pushDebugLog('oauth.response.capture.registered', {});
        },
        onRegisterError: (error: unknown) => {
          setState({
            oauth_response_capture_supported: false,
            oauth_response_capture_reason: stringifyError(error),
            oauth_response_capture_checked_at: nowIso(),
          });
          pushDebugLog('oauth.response.capture.register_error', { error: stringifyError(error) });
        },
      });
    }

    // ─────────────────────────────────────────────────────────────
    // Alarm scheduling
    // ─────────────────────────────────────────────────────────────

    function schedule(): void {
      browser.alarms.create('oidc_sync', { periodInMinutes: 1 });
      pushDebugLog('alarm.scheduled', { name: 'oidc_sync', period_minutes: 1 });
      // Periodic studiesHistory compaction — decoupled from the ingest hot path. Create it ONLY if it
      // doesn't already exist: schedule() runs on every event-page/service-worker cold start (which
      // oidc_sync triggers ~1×/min), and re-creating an alarm resets its countdown — so recreating a
      // long-period alarm every wake would starve it and it would never fire.
      void browser.alarms.get('history_prune').then((existing) => {
        if (existing) return;
        browser.alarms.create('history_prune', { periodInMinutes: STUDY_HISTORY_PRUNE_PERIOD_MINUTES });
        pushDebugLog('alarm.scheduled', { name: 'history_prune', period_minutes: STUDY_HISTORY_PRUNE_PERIOD_MINUTES });
      });
      // Storage-quota watchdog — same guard rationale as history_prune (don't reset a long-period
      // alarm on every wake). Runs more often than compaction so pressure is caught well before writes
      // fail; the emergency prune only bites under critical pressure.
      void browser.alarms.get('storage_check').then((existing) => {
        if (existing) return;
        browser.alarms.create('storage_check', { periodInMinutes: STORAGE_QUOTA_CHECK_PERIOD_MINUTES });
        pushDebugLog('alarm.scheduled', { name: 'storage_check', period_minutes: STORAGE_QUOTA_CHECK_PERIOD_MINUTES });
      });
    }

    function registerCaptureListeners(): void {
      registerStudiesCompletedCapture();
      registerOAuthCompletedFallbackListener();

      // filterResponseData is Firefox-only; skip all blocking captures on Chrome
      if (!getFilterResponseDataFunction()) {
        setState({
          studies_response_capture_supported: false,
          studies_response_capture_registered: false,
          studies_response_capture_ok: null,
          studies_response_capture_reason: 'filterResponseData not supported',
          studies_response_capture_checked_at: nowIso(),
        });
        return;
      }

      registerStudiesResponseCaptureIfSupported();
      registerSubmissionResponseCaptureIfSupported();
      registerParticipantSubmissionsResponseCaptureIfSupported();
      registerOAuthResponseCaptureIfSupported();
    }

    // ─────────────────────────────────────────────────────────────
    // Settings response builder
    // ─────────────────────────────────────────────────────────────

    function buildRefreshSettingsResponse(refreshPolicy: Record<string, number>, autoOpenEnabled?: boolean): Record<string, unknown> {
      const settings: Record<string, unknown> = {
        studies_refresh_min_delay_seconds: refreshPolicy.minimum_delay_seconds,
        studies_refresh_average_delay_seconds: refreshPolicy.average_delay_seconds,
        studies_refresh_spread_seconds: refreshPolicy.spread_seconds,
        studies_refresh_cycle_seconds: refreshPolicy.cycle_seconds,
      };
      if (typeof autoOpenEnabled === 'boolean') {
        settings.auto_open_prolific_tab = autoOpenEnabled;
      }
      return settings;
    }

    // ─────────────────────────────────────────────────────────────
    // Runtime message handler
    // ─────────────────────────────────────────────────────────────

    function sendRuntimeError(sendResponse: (response: Record<string, unknown>) => void, error: unknown): void {
      sendResponse({ ok: false, error: stringifyError(error) });
    }

    function runMessageTask(sendResponse: (response: Record<string, unknown>) => void, task: () => Promise<void>): boolean {
      (async () => {
        try {
          await task();
        } catch (error) {
          sendRuntimeError(sendResponse, error);
        }
      })();
      return true;
    }

    browser.runtime.onMessage.addListener((message: unknown, _sender: unknown, sendResponse: (response?: unknown) => void): boolean | void => {
      const msg = message as Record<string, unknown> | null;

      // Content script intercepted API response (Chrome path).
      if (msg && msg.action === 'interceptedResponse') {
        handleInterceptedResponse(msg);
        return false;
      }

      if (msg && msg.action === 'setAutoOpen') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const enabled = Boolean(msg.enabled);
          await storageSetLocal({ [AUTO_OPEN_PROLIFIC_TAB_KEY]: enabled });
          await setState({ auto_open_enabled: enabled });
          await pushDebugLog('settings.auto_open.updated', { enabled });

          sendResponse({ ok: true, auto_open_prolific_tab: enabled });

          if (!enabled) {
            lastAutoOpenedTabId = null;
            return;
          }

          const tabs = await queryProlificTabs();
          if (tabs.length === 0) {
            await maybeAutoOpenProlificTab('settings.auto_open.enabled', tabs);
            return;
          }

          await requestTokenSync('settings.auto_open.enabled');
        });
      }

      if (msg && msg.action === 'setPriorityFilters') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const filters = normalizePriorityFilters(msg.filters);

          await storageSetLocal({
            [PRIORITY_FILTERS_KEY]: filters,
          });

          const enabledCount = filters.filter((f: PriorityFilter) => f.enabled).length;
          await setState({
            priority_filters_count: filters.length,
            priority_filters_enabled_count: enabledCount,
          });
          await pushDebugLog('settings.priority_filters.updated', {
            count: filters.length,
            enabled_count: enabledCount,
          });

          sendResponse({ ok: true, filters });
        });
      }

      if (msg && msg.action === 'setRefreshDelays') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const refreshPolicy = normalizeStudiesRefreshPolicy(
            msg.minimum_delay_seconds,
            msg.average_delay_seconds,
            msg.spread_seconds,
          );

          // Write to storage and confirm before responding
          const writeItems = {
            [STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY]: refreshPolicy.minimum_delay_seconds,
            [STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY]: refreshPolicy.average_delay_seconds,
            [STUDIES_REFRESH_SPREAD_SECONDS_KEY]: refreshPolicy.spread_seconds,
          };
          await browser.storage.local.set(writeItems);

          sendResponse({
            ok: true,
            settings: buildRefreshSettingsResponse(refreshPolicy),
          });

          scheduleDelayedRefreshes('extension.settings.save', refreshPolicy);
          pushDebugLog('settings.studies_refresh_policy.schedule_ok', refreshPolicy as unknown as Record<string, unknown>);

          setState({
            studies_refresh_min_delay_seconds: refreshPolicy.minimum_delay_seconds,
            studies_refresh_average_delay_seconds: refreshPolicy.average_delay_seconds,
            studies_refresh_spread_seconds: refreshPolicy.spread_seconds,
            studies_refresh_cycle_seconds: refreshPolicy.cycle_seconds,
          });
          pushDebugLog('settings.studies_refresh_policy.updated', refreshPolicy as unknown as Record<string, unknown>);
        });
      }

      if (msg && msg.action === 'clearDebugLogs') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          await updateState(() => ({
            debug_logs: [],
          }));
          sendResponse({ ok: true });
        });
      }

      if (msg && msg.action === 'setTelegramSettings') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const prev = cachedTelegramSettings;
          const settings = await saveTelegramSettings(msg.settings as TelegramSettings);
          cachedTelegramSettings = settings;
          if (!prev || prev.enabled !== settings.enabled) {
            await setState({ telegram_enabled: settings.enabled });
          }
          pushDebugLog('settings.telegram.updated', {
            enabled: settings.enabled,
            notify_all: settings.notify_all_studies,
          });
          sendResponse({ ok: true, settings });
        });
      }

      if (msg && msg.action === 'getTelegramSettings') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const settings = cachedTelegramSettings ?? await refreshTelegramSettingsCache();
          sendResponse({ ok: true, settings });
        });
      }

      if (msg && msg.action === 'testTelegramMessage') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const settings = normalizeTelegramSettings(msg.settings);
          if (!settings.bot_token || !settings.chat_id) {
            sendResponse({ ok: false, error: 'Bot token and chat ID are required' });
            return;
          }
          const result = await sendTelegramTestMessage(settings.bot_token, settings.chat_id, settings.message_format);
          if (result.ok) {
            pushDebugLog('telegram.test.sent', {});
          } else {
            pushDebugLog('telegram.test.error', { error: result.description || result.error });
          }
          sendResponse(result);
        });
      }

      if (msg && msg.action === 'verifyTelegramBot') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const result = await verifyTelegramBot(String(msg.bot_token || ''));
          sendResponse(result);
        });
      }

      if (msg && msg.action === 'sendStudyToTelegram') {
        return runMessageTask(sendResponse as (response: Record<string, unknown>) => void, async () => {
          const settings = cachedTelegramSettings ?? await refreshTelegramSettingsCache();
          if (!isTelegramConfigured(settings)) {
            sendResponse({ ok: false, error: 'Telegram is not configured' });
            return;
          }
          const study = msg.study as Study | undefined;
          if (!study || typeof study !== 'object') {
            sendResponse({ ok: false, error: 'Missing study payload' });
            return;
          }
          const ok = await sendStudyTelegramMessage(study, null, settings);
          sendResponse({ ok });
        });
      }

      return false;
    });

    // ─────────────────────────────────────────────────────────────
    // Event listeners
    // ─────────────────────────────────────────────────────────────

    browser.runtime.onInstalled.addListener(() => {
      boot('onInstalled', 'runtime.installed').catch(() => {
        // Keep extension startup resilient.
      });
    });

    browser.runtime.onStartup.addListener(() => {
      boot('onStartup', 'runtime.startup').catch(() => {
        // Keep extension startup resilient.
      });
    });

    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'oidc_sync') {
        pushDebugLog('alarm.fired', { name: alarm.name });
        requestTokenSync('alarm');
      } else if (alarm.name === 'history_prune') {
        // Best-effort maintenance — log failures to diagnostics instead of dying silently.
        void store.pruneStudyHistory().catch((error) => pushDebugLog('history_prune.error', { error: stringifyError(error) }));
      } else if (alarm.name === 'storage_check') {
        void checkStorageQuota('alarm');
      }
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status !== 'complete' || !tab.url) {
        return;
      }
      if (tab.url.includes('app.prolific.com') || tab.url.includes('auth.prolific.com')) {
        pushDebugLog('tab.updated.prolific', { tab_id: tabId });
        requestTokenSync('tabs.onUpdated');
      }
    });

    browser.tabs.onRemoved.addListener((tabId) => {
      if (typeof tabId === 'number' && tabId === lastAutoOpenedTabId) {
        lastAutoOpenedTabId = null;
      }
      pushDebugLog('tab.removed', { tab_id: tabId });
      requestTokenSync('tabs.onRemoved');
    });

    // ─────────────────────────────────────────────────────────────
    // Boot function
    // ─────────────────────────────────────────────────────────────

    async function boot(trigger: string, logEvent?: string): Promise<void> {
      if (logEvent) {
        await pushDebugLog(logEvent, {});
      }
      await migrateLegacyPriorityFilter();
      await priorityStateRuntime.ensureHydrated();

      try {
        const tgSettings = await refreshTelegramSettingsCache();
        await setState({ telegram_enabled: tgSettings.enabled });
      } catch {
        // Non-critical
      }

      schedule();
      registerCaptureListeners();
      // One-shot storage check at startup so the popup shows quota status immediately and an
      // already-full profile is compacted before the first refresh writes.
      void checkStorageQuota('boot');
      await requestTokenSync(trigger);

      // If we got a token and there's an open Prolific tab, do one immediate
      // fetch so that "install with tab already open" isn't stuck on "never".
      try {
        const existing = await browser.storage.local.get(STATE_KEY);
        const state = (existing[STATE_KEY] as Record<string, unknown>) || {};
        if (state.token_ok) {
          const tabs = await queryProlificTabs();
          const tabId = tabs[0]?.id;
          if (typeof tabId === 'number') {
            pushDebugLog('boot.initial_refresh', { trigger, tab_id: tabId });
            const result = await fetchStudiesInTab(tabId);
            if (result.ok && result.status_code === 200) {
              const observedAt = nowIso();
              let parsedBody: unknown;
              try { parsedBody = JSON.parse(result.body as string); } catch { /* ignore */ }
              if (parsedBody) {
                await ingestStudiesResponse(parsedBody, observedAt, 'boot.initial_refresh', FETCH_STUDIES_API_URL, result.status_code as number);
                notifyPopupDashboardUpdated('boot.initial_refresh', observedAt);
                const refreshPolicy = await getStudiesRefreshPolicySettings();
                scheduleDelayedRefreshes('boot.initial_refresh', refreshPolicy);
              }
            }
          }
        }
      } catch (err) {
        pushDebugLog('boot.initial_refresh.error', { error: stringifyError(err) });
      }
    }

    boot('startup-load', 'extension.init').catch(() => {
      // Keep extension startup resilient.
    });
  },
});
