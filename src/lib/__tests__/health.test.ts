import { describe, it, expect } from 'vitest';
import {
  classifyRefreshStatus,
  classifyStoragePressure,
  decideAuthRecoveryAction,
  isQuotaError,
  createRefreshHealthTracker,
} from '../../entrypoints/background/health';

// ── classifyRefreshStatus ──────────────────────────────────────

describe('classifyRefreshStatus', () => {
  it('maps 200 to ok', () => {
    expect(classifyRefreshStatus(200)).toBe('ok');
  });

  it('maps 401 to auth_expired', () => {
    expect(classifyRefreshStatus(401)).toBe('auth_expired');
  });

  it('does NOT treat 403 as auth_expired (issue scopes to 401)', () => {
    expect(classifyRefreshStatus(403)).toBe('client_error');
  });

  it('maps 429 to rate_limited', () => {
    expect(classifyRefreshStatus(429)).toBe('rate_limited');
  });

  it('maps 5xx to server_error', () => {
    expect(classifyRefreshStatus(500)).toBe('server_error');
    expect(classifyRefreshStatus(503)).toBe('server_error');
  });

  it('maps other 4xx to client_error', () => {
    expect(classifyRefreshStatus(404)).toBe('client_error');
    expect(classifyRefreshStatus(400)).toBe('client_error');
  });
});

// ── classifyStoragePressure ────────────────────────────────────

describe('classifyStoragePressure', () => {
  const thresholds = { warnRatio: 0.75, criticalRatio: 0.9 };

  it('reports ok well below the warn threshold', () => {
    const p = classifyStoragePressure({ usage: 10, quota: 100 }, thresholds);
    expect(p.level).toBe('ok');
    expect(p.ratio).toBeCloseTo(0.1);
  });

  it('reports warn between warn and critical ratios', () => {
    expect(classifyStoragePressure({ usage: 80, quota: 100 }, thresholds).level).toBe('warn');
    expect(classifyStoragePressure({ usage: 75, quota: 100 }, thresholds).level).toBe('warn');
  });

  it('reports critical at/above the critical ratio', () => {
    expect(classifyStoragePressure({ usage: 90, quota: 100 }, thresholds).level).toBe('critical');
    expect(classifyStoragePressure({ usage: 99, quota: 100 }, thresholds).level).toBe('critical');
  });

  it('never panics on a zero/missing quota (private-mode / unsupported)', () => {
    expect(classifyStoragePressure({ usage: 999, quota: 0 }, thresholds).level).toBe('ok');
    expect(classifyStoragePressure({ usage: 999 }, thresholds).level).toBe('ok');
    expect(classifyStoragePressure(null, thresholds).level).toBe('ok');
    expect(classifyStoragePressure(undefined, thresholds).level).toBe('ok');
  });

  it('coerces NaN/negative values to zero rather than producing junk ratios', () => {
    const p = classifyStoragePressure({ usage: Number.NaN, quota: -5 }, thresholds);
    expect(p.usage).toBe(0);
    expect(p.quota).toBe(0);
    expect(p.ratio).toBe(0);
    expect(p.level).toBe('ok');
  });
});

// ── decideAuthRecoveryAction ───────────────────────────────────

describe('decideAuthRecoveryAction', () => {
  const limits = { resyncMax: 2, reloadMax: 4 };

  it('resyncs on the first couple of auth failures', () => {
    expect(decideAuthRecoveryAction(1, limits)).toBe('resync');
    expect(decideAuthRecoveryAction(2, limits)).toBe('resync');
  });

  it('reloads the tab in the middle band', () => {
    expect(decideAuthRecoveryAction(3, limits)).toBe('reload_tab');
    expect(decideAuthRecoveryAction(4, limits)).toBe('reload_tab');
  });

  it('gives up and requires auth past the reload band', () => {
    expect(decideAuthRecoveryAction(5, limits)).toBe('require_auth');
    expect(decideAuthRecoveryAction(50, limits)).toBe('require_auth');
  });

  it('treats a non-finite count as a first attempt', () => {
    expect(decideAuthRecoveryAction(Number.NaN, limits)).toBe('resync');
  });
});

// ── isQuotaError ───────────────────────────────────────────────

describe('isQuotaError', () => {
  it('detects the DOMException name', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
  });

  it('detects legacy Chrome (22) and Firefox (1014) codes', () => {
    expect(isQuotaError({ code: 22 })).toBe(true);
    expect(isQuotaError({ code: 1014 })).toBe(true);
  });

  it('detects the Firefox NS_ERROR name', () => {
    expect(isQuotaError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' })).toBe(true);
  });

  it('detects quota mentions in the message', () => {
    expect(isQuotaError(new Error('The quota has been exceeded.'))).toBe(true);
    expect(isQuotaError(new Error('exceeded the storage quota'))).toBe(true);
  });

  it('ignores unrelated errors and non-objects', () => {
    expect(isQuotaError(new Error('network down'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError('quota')).toBe(false); // strings are not error objects
    expect(isQuotaError({ code: 99 })).toBe(false);
  });
});

// ── createRefreshHealthTracker ─────────────────────────────────

describe('createRefreshHealthTracker', () => {
  it('starts clean', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 3 });
    const s = t.snapshot();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.consecutiveAuthFailures).toBe(0);
    expect(s.lastOutcome).toBeNull();
    expect(s.persistentlyFailing).toBe(false);
  });

  it('counts consecutive failures and flips persistentlyFailing at the threshold', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 3 });
    expect(t.record('server_error').persistentlyFailing).toBe(false);
    expect(t.record('server_error').persistentlyFailing).toBe(false);
    const s = t.record('server_error');
    expect(s.consecutiveFailures).toBe(3);
    expect(s.persistentlyFailing).toBe(true);
  });

  it('a clean ok resets all counters', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 2 });
    t.record('auth_expired');
    t.record('auth_expired');
    const ok = t.record('ok');
    expect(ok.consecutiveFailures).toBe(0);
    expect(ok.consecutiveAuthFailures).toBe(0);
    expect(ok.persistentlyFailing).toBe(false);
    expect(ok.lastOutcome).toBe('ok');
  });

  it('tracks consecutive auth failures separately for escalation', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 5 });
    expect(t.record('auth_expired').consecutiveAuthFailures).toBe(1);
    expect(t.record('auth_expired').consecutiveAuthFailures).toBe(2);
  });

  it('a non-auth failure breaks the auth streak but not the overall failure streak', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 5 });
    t.record('auth_expired');
    t.record('auth_expired');
    const s = t.record('server_error');
    expect(s.consecutiveAuthFailures).toBe(0);
    expect(s.consecutiveFailures).toBe(3);
  });

  it('reset() clears everything', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 2 });
    t.record('auth_expired');
    t.record('auth_expired');
    t.reset();
    const s = t.snapshot();
    expect(s.consecutiveFailures).toBe(0);
    expect(s.consecutiveAuthFailures).toBe(0);
    expect(s.lastOutcome).toBeNull();
    expect(s.persistentlyFailing).toBe(false);
  });
});

// ── Adversarial: composed failure sequences (mirrors the index.ts wiring) ──────
// These exercise the exact composition the background uses — classify a status, fold it into the
// tracker, then pick a recovery action — under realistic hostile bursts the unit pieces don't cover
// individually. The background orchestration itself isn't unit-testable (closure), so this is the
// closest guard against a regression in the decision path.

describe('adversarial: auth-expiry escalation over a burst of 401s', () => {
  const limits = { resyncMax: 2, reloadMax: 4 };

  it('escalates resync → reload_tab → require_auth as 401s pile up, then a 200 fully recovers', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 3 });
    const actions: string[] = [];
    // Six consecutive 401s from the studies endpoint.
    for (let i = 0; i < 6; i++) {
      const outcome = classifyRefreshStatus(401);
      const snap = t.record(outcome);
      actions.push(decideAuthRecoveryAction(snap.consecutiveAuthFailures, limits));
    }
    expect(actions).toEqual(['resync', 'resync', 'reload_tab', 'reload_tab', 'require_auth', 'require_auth']);

    // A single good refresh clears everything — the very next 401 starts the ladder over.
    t.record(classifyRefreshStatus(200));
    const afterRecovery = t.record(classifyRefreshStatus(401));
    expect(afterRecovery.consecutiveAuthFailures).toBe(1);
    expect(decideAuthRecoveryAction(afterRecovery.consecutiveAuthFailures, limits)).toBe('resync');
  });

  it('a 500 interleaved with 401s resets the auth ladder but keeps the overall failure streak', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 3 });
    t.record(classifyRefreshStatus(401)); // auth streak 1
    t.record(classifyRefreshStatus(401)); // auth streak 2
    const afterServer = t.record(classifyRefreshStatus(503)); // breaks auth streak
    expect(afterServer.consecutiveAuthFailures).toBe(0);
    expect(afterServer.consecutiveFailures).toBe(3);
    expect(afterServer.persistentlyFailing).toBe(true);
    // Next 401 is treated as a fresh auth problem → gentle resync, not an immediate give-up.
    const afterAuth = t.record(classifyRefreshStatus(401));
    expect(decideAuthRecoveryAction(afterAuth.consecutiveAuthFailures, limits)).toBe('resync');
  });
});

describe('adversarial: persistent non-auth outage never masquerades as an auth problem', () => {
  it('a run of network errors flips persistentlyFailing without ever escalating to require_auth', () => {
    const t = createRefreshHealthTracker({ persistentThreshold: 3 });
    let snap = t.snapshot();
    for (let i = 0; i < 5; i++) snap = t.record('network_error');
    expect(snap.persistentlyFailing).toBe(true);
    expect(snap.consecutiveAuthFailures).toBe(0);
    expect(decideAuthRecoveryAction(snap.consecutiveAuthFailures, { resyncMax: 2, reloadMax: 4 })).toBe('resync');
  });
});

describe('adversarial: storage pressure right at the boundaries', () => {
  const thresholds = { warnRatio: 0.75, criticalRatio: 0.9 };

  it('is exclusive/inclusive exactly as documented at the edges', () => {
    // Just below warn → ok; exactly warn → warn; just below critical → warn; exactly critical → critical.
    expect(classifyStoragePressure({ usage: 7499, quota: 10000 }, thresholds).level).toBe('ok');
    expect(classifyStoragePressure({ usage: 7500, quota: 10000 }, thresholds).level).toBe('warn');
    expect(classifyStoragePressure({ usage: 8999, quota: 10000 }, thresholds).level).toBe('warn');
    expect(classifyStoragePressure({ usage: 9000, quota: 10000 }, thresholds).level).toBe('critical');
  });

  it('treats usage over quota (already blown) as critical, not a >1 ratio bug', () => {
    const p = classifyStoragePressure({ usage: 200, quota: 100 }, thresholds);
    expect(p.level).toBe('critical');
    expect(p.ratio).toBe(2);
  });
});
