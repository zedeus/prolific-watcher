// Global pause (issue #21).
//
// One switch the user flips to make the extension go quiet: no periodic
// refresh/requests, nothing opening automatically, no filter evaluation. Pause
// can be indefinite ("until I resume") or timed, in which case it lapses on its
// own. The stored shape is `{ until }` where `until` is an epoch-ms deadline or
// `null` for indefinite; absence / an expired deadline means "not paused".
//
// This module is pure (no browser/storage access) so it's unit-testable and
// shared by the background (hot-path guards) and the popup (banner + controls).

/** How long a pause lasts. `forever` stays until the user manually resumes. */
export type PauseDuration = '1h' | '8h' | 'forever';

export interface PauseState {
  /** Epoch ms when the pause auto-resumes, or `null` for indefinite. */
  until: number | null;
}

const PAUSE_DURATION_MS: Record<Exclude<PauseDuration, 'forever'>, number> = {
  '1h': 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
};

/** Compute the resume deadline for a duration, or `null` for `forever`. */
export function pauseUntilFromDuration(duration: PauseDuration, nowMS: number): number | null {
  if (duration === 'forever') return null;
  const ms = PAUSE_DURATION_MS[duration];
  return ms ? nowMS + ms : null;
}

/**
 * Validate raw stored pause data. Returns the live pause state, or `null` when
 * not paused — including a timed pause whose deadline has already lapsed.
 */
export function normalizePauseState(raw: unknown, nowMS: number): PauseState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  let until: number | null;
  if (r.until === null || r.until === undefined) {
    until = null;
  } else if (typeof r.until === 'number' && Number.isFinite(r.until)) {
    until = r.until;
  } else {
    return null;
  }

  if (until !== null && until <= nowMS) return null; // lapsed → not paused
  return { until };
}

/**
 * Bare remaining time for a timed pause (e.g. "47m", "8h") so each surface can
 * phrase it ("· 47m left", "resumes in 8h"). Empty for an indefinite pause or
 * when not paused.
 */
export function pauseRemainingLabel(state: PauseState | null, nowMS: number): string {
  if (!state || state.until === null) return '';
  const remaining = state.until - nowMS;
  if (remaining <= 0) return '';
  const minutes = Math.round(remaining / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}
