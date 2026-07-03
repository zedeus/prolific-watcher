/**
 * Backend resilience helpers (issue #25) — pure logic for token-expiry recovery, storage-quota
 * pressure, and persistent refresh-failure tracking. Deliberately free of browser APIs so it can be
 * unit-tested in isolation; index.ts owns the IO (HTTP status, navigator.storage.estimate, alarms,
 * state writes) and delegates the *decisions* here.
 */

// ─────────────────────────────────────────────────────────────
// Refresh outcome classification
// ─────────────────────────────────────────────────────────────

export type RefreshOutcome =
  | 'ok'
  | 'auth_expired'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'network_error';

/**
 * Map the HTTP status of a studies refresh into a coarse health outcome. A missing/invalid status
 * (e.g. a network failure that never reached the server) is treated as a network error by callers;
 * only real response codes reach this function.
 */
export function classifyRefreshStatus(statusCode: number): RefreshOutcome {
  if (statusCode === 200) return 'ok';
  // Prolific returns 401 when the bearer token has expired or been revoked.
  if (statusCode === 401) return 'auth_expired';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 500) return 'server_error';
  return 'client_error';
}

// ─────────────────────────────────────────────────────────────
// Storage-quota pressure
// ─────────────────────────────────────────────────────────────

export type StoragePressureLevel = 'ok' | 'warn' | 'critical';

export interface StorageEstimateInput {
  usage?: number;
  quota?: number;
}

export interface StoragePressure {
  usage: number;
  quota: number;
  ratio: number;
  level: StoragePressureLevel;
}

/**
 * Classify how close we are to the storage quota. Guards against a missing/zero/NaN quota
 * (`navigator.storage.estimate()` can return `undefined` fields, or `quota: 0` in private-mode
 * quirks) by reporting `ok`/ratio 0 rather than dividing by zero — we never panic-prune on a
 * quota we can't actually measure.
 */
export function classifyStoragePressure(
  estimate: StorageEstimateInput | null | undefined,
  thresholds: { warnRatio: number; criticalRatio: number },
): StoragePressure {
  const rawUsage = Number(estimate?.usage);
  const rawQuota = Number(estimate?.quota);
  const usage = Number.isFinite(rawUsage) && rawUsage > 0 ? rawUsage : 0;
  const quota = Number.isFinite(rawQuota) && rawQuota > 0 ? rawQuota : 0;
  const ratio = quota > 0 ? usage / quota : 0;

  let level: StoragePressureLevel = 'ok';
  if (quota > 0) {
    if (ratio >= thresholds.criticalRatio) level = 'critical';
    else if (ratio >= thresholds.warnRatio) level = 'warn';
  }

  return { usage, quota, ratio, level };
}

// ─────────────────────────────────────────────────────────────
// Auth-recovery escalation
// ─────────────────────────────────────────────────────────────

export type AuthRecoveryAction = 'resync' | 'reload_tab' | 'require_auth';

/**
 * Decide how hard to try recovering from repeated auth failures, escalating with each consecutive
 * 401 so we never tight-loop on a dead token:
 *   - first attempts → `resync`      (re-read the tab's OIDC token; it may have silently rotated)
 *   - then           → `reload_tab`  (force the Prolific tab to silent-renew its session)
 *   - finally        → `require_auth` (give up and tell the user to log in)
 */
export function decideAuthRecoveryAction(
  consecutiveAuthFailures: number,
  limits: { resyncMax: number; reloadMax: number },
): AuthRecoveryAction {
  const n = Number.isFinite(consecutiveAuthFailures) ? consecutiveAuthFailures : 1;
  if (n <= limits.resyncMax) return 'resync';
  if (n <= limits.reloadMax) return 'reload_tab';
  return 'require_auth';
}

// ─────────────────────────────────────────────────────────────
// Quota-error detection
// ─────────────────────────────────────────────────────────────

/**
 * Detect a storage-quota-exceeded error across browsers so a silently-failing write can trigger an
 * emergency prune instead of being swallowed. Covers the DOMException name/legacy codes used by
 * Chrome (22) and Firefox (1014 / NS_ERROR_DOM_QUOTA_REACHED) plus message-based fallbacks.
 */
export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof name === 'string' && /quota|NS_ERROR_DOM_QUOTA/i.test(name)) return true;
  if (code === 22 || code === 1014) return true;
  if (typeof message === 'string' && /quota|exceeded the storage|storage is full|maximum size/i.test(message)) {
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Persistent refresh-failure tracker
// ─────────────────────────────────────────────────────────────

export interface RefreshHealthSnapshot {
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  lastOutcome: RefreshOutcome | null;
  persistentlyFailing: boolean;
}

export interface RefreshHealthTracker {
  /** Fold an outcome into the running counters and return the resulting snapshot. */
  record(outcome: RefreshOutcome): RefreshHealthSnapshot;
  snapshot(): RefreshHealthSnapshot;
  reset(): void;
}

/**
 * Track consecutive refresh failures so the UI can distinguish a one-off blip from a session that
 * has genuinely stopped updating. A clean `ok` resets everything; a run of failures at/above
 * `persistentThreshold` flips `persistentlyFailing`, which the popup renders as a clear recovery
 * state. Auth failures are counted separately to drive escalation (see decideAuthRecoveryAction).
 */
export function createRefreshHealthTracker(opts: { persistentThreshold: number }): RefreshHealthTracker {
  let consecutiveFailures = 0;
  let consecutiveAuthFailures = 0;
  let lastOutcome: RefreshOutcome | null = null;

  const persistentlyFailing = (): boolean => consecutiveFailures >= opts.persistentThreshold;

  const snapshot = (): RefreshHealthSnapshot => ({
    consecutiveFailures,
    consecutiveAuthFailures,
    lastOutcome,
    persistentlyFailing: persistentlyFailing(),
  });

  return {
    record(outcome) {
      lastOutcome = outcome;
      if (outcome === 'ok') {
        consecutiveFailures = 0;
        consecutiveAuthFailures = 0;
      } else {
        consecutiveFailures += 1;
        // A non-auth failure breaks the auth streak (different failure mode) but still counts as a
        // failure overall — otherwise escalation could misfire on an unrelated blip.
        consecutiveAuthFailures = outcome === 'auth_expired' ? consecutiveAuthFailures + 1 : 0;
      }
      return snapshot();
    },
    snapshot,
    reset() {
      consecutiveFailures = 0;
      consecutiveAuthFailures = 0;
      lastOutcome = null;
    },
  };
}
