// Manual snooze / block list (issue #21).
//
// A small, persisted list of "mutes" the user creates by right-clicking a study
// (or researcher) in the popup to silence it for 1h / 24h / forever — without
// touching their priority filters. The evaluation path checks this list before
// alerting or auto-opening, so a muted study still shows in the Live list but
// makes no noise.
//
// This module is pure (no browser/storage access) so it can be unit-tested
// directly and imported from both the background and the popup.

import { MAX_MUTE_ENTRIES } from './constants';

/** What a mute targets: a single study, or every study from a researcher. */
export type MuteScope = 'study' | 'researcher';

/** How long a mute lasts. `forever` is a permanent block until manually removed. */
export type MuteDuration = '1h' | '24h' | 'forever';

export interface MuteEntry {
  scope: MuteScope;
  /** study_id (scope `study`) or researcher_id (scope `researcher`). */
  id: string;
  /** Human-friendly label for the management UI (study name / researcher name). */
  label: string;
  /** Epoch ms when the mute expires, or `null` for a permanent block. */
  until: number | null;
  /** Epoch ms the mute was created (used for ordering + dedup tie-breaks). */
  created_at: number;
}

const MUTE_DURATION_MS: Record<Exclude<MuteDuration, 'forever'>, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
};

/** Compute the expiry timestamp for a duration, or `null` for `forever`. */
export function muteUntilFromDuration(duration: MuteDuration, nowMS: number): number | null {
  if (duration === 'forever') return null;
  const ms = MUTE_DURATION_MS[duration];
  return ms ? nowMS + ms : null;
}

function muteKey(scope: MuteScope, id: string): string {
  return `${scope}:${id}`;
}

// A permanent mute outranks any timed mute; among timed mutes the later expiry
// wins. Used to pick the "strongest" survivor when the same target is muted
// more than once.
function muteRank(entry: MuteEntry): number {
  return entry.until === null ? Number.POSITIVE_INFINITY : entry.until;
}

function normalizeMuteEntry(raw: unknown): MuteEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const scope: MuteScope | null =
    r.scope === 'researcher' ? 'researcher' : r.scope === 'study' ? 'study' : null;
  if (!scope) return null;

  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id) return null;

  const label = typeof r.label === 'string' ? r.label.trim() : '';

  let until: number | null;
  if (r.until === null || r.until === undefined) {
    until = null;
  } else if (typeof r.until === 'number' && Number.isFinite(r.until)) {
    until = r.until;
  } else {
    // Garbage expiry — reject the whole entry rather than risk a permanent mute.
    return null;
  }

  const created_at =
    typeof r.created_at === 'number' && Number.isFinite(r.created_at) ? r.created_at : 0;

  return { scope, id, label, until, created_at };
}

/**
 * Validate, prune (drop expired), dedup, and cap a raw mute list. Safe to call
 * on untrusted storage data. Expired timed mutes are removed relative to
 * `nowMS`; duplicates for the same target collapse to the strongest survivor.
 */
export function normalizeMuteList(raw: unknown, nowMS: number): MuteEntry[] {
  if (!Array.isArray(raw)) return [];

  const byKey = new Map<string, MuteEntry>();
  for (const item of raw) {
    const entry = normalizeMuteEntry(item);
    if (!entry) continue;
    if (entry.until !== null && entry.until <= nowMS) continue; // expired

    const key = muteKey(entry.scope, entry.id);
    const existing = byKey.get(key);
    if (!existing || muteRank(entry) > muteRank(existing)) {
      byKey.set(key, entry);
    }
  }

  const list = [...byKey.values()];
  // Newest first so the management UI shows recent mutes at the top.
  list.sort((a, b) => b.created_at - a.created_at);
  return list.slice(0, MAX_MUTE_ENTRIES);
}

/** Build a mute entry for a target + duration. */
export function createMuteEntry(
  scope: MuteScope,
  id: string,
  label: string,
  duration: MuteDuration,
  nowMS: number,
): MuteEntry {
  return {
    scope,
    id: (id || '').trim(),
    label: (label || '').trim(),
    until: muteUntilFromDuration(duration, nowMS),
    created_at: nowMS,
  };
}

/** Add (or replace) a mute for a target, then re-normalize. */
export function addMuteEntry(mutes: MuteEntry[], entry: MuteEntry, nowMS: number): MuteEntry[] {
  const key = muteKey(entry.scope, entry.id);
  const next = mutes.filter((m) => muteKey(m.scope, m.id) !== key);
  next.unshift(entry);
  return normalizeMuteList(next, nowMS);
}

/** Remove a mute for a specific target. */
export function removeMuteEntry(mutes: MuteEntry[], scope: MuteScope, id: string): MuteEntry[] {
  const key = muteKey(scope, (id || '').trim());
  return mutes.filter((m) => muteKey(m.scope, m.id) !== key);
}

interface StudyLike {
  id?: string;
  researcher?: { id?: string } | null;
}

/**
 * Is this study currently muted — either directly, or via a mute on its
 * researcher? Expired timed mutes never match.
 */
export function isStudyMuted(
  study: StudyLike | null | undefined,
  mutes: MuteEntry[],
  nowMS: number,
): boolean {
  if (!study || !mutes.length) return false;
  const studyId = typeof study.id === 'string' ? study.id.trim() : '';
  const researcherId = typeof study.researcher?.id === 'string' ? study.researcher.id.trim() : '';
  if (!studyId && !researcherId) return false;

  for (const m of mutes) {
    if (m.until !== null && m.until <= nowMS) continue; // expired
    if (m.scope === 'study' && studyId && m.id === studyId) return true;
    if (m.scope === 'researcher' && researcherId && m.id === researcherId) return true;
  }
  return false;
}

/** True if a specific target has an active mute (used to toggle menu labels). */
export function isTargetMuted(
  scope: MuteScope,
  id: string,
  mutes: MuteEntry[],
  nowMS: number,
): boolean {
  const target = (id || '').trim();
  if (!target) return false;
  return mutes.some(
    (m) => m.scope === scope && m.id === target && (m.until === null || m.until > nowMS),
  );
}
