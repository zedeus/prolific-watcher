import { browser } from 'wxt/browser';
import {
  MUTE_LIST_KEY,
  AUTO_OPEN_DURING_SUBMISSION_KEY,
  DEFAULT_AUTO_OPEN_DURING_SUBMISSION,
  type AutoOpenDuringSubmission,
} from '../../lib/constants';
import { normalizeMuteList, type MuteEntry } from '../../lib/mutes';

/**
 * Load the persisted mute list, pruning any expired entries relative to now.
 * A missing key yields an empty list.
 */
export async function loadMuteList(nowMS: number = Date.now()): Promise<MuteEntry[]> {
  const data = await browser.storage.local.get(MUTE_LIST_KEY);
  return normalizeMuteList(data[MUTE_LIST_KEY], nowMS);
}

/** Persist a mute list (re-normalized/pruned) and return the saved value. */
export async function saveMuteList(
  mutes: MuteEntry[],
  nowMS: number = Date.now(),
): Promise<MuteEntry[]> {
  const normalized = normalizeMuteList(mutes, nowMS);
  await browser.storage.local.set({ [MUTE_LIST_KEY]: normalized });
  return normalized;
}

/** Read the "what auto-open does during a submission" setting, with default. */
export async function loadAutoOpenDuringSubmission(): Promise<AutoOpenDuringSubmission> {
  const data = await browser.storage.local.get(AUTO_OPEN_DURING_SUBMISSION_KEY);
  const value = data[AUTO_OPEN_DURING_SUBMISSION_KEY];
  return value === 'skip' || value === 'background' ? value : DEFAULT_AUTO_OPEN_DURING_SUBMISSION;
}
