import { browser } from 'wxt/browser';
import type { Study, PriorityFilter } from '../../lib/types';
import type { SoundType } from '../../lib/constants';
import {
  PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH,
  DEFAULT_PRIORITY_ALERT_SOUND_TYPE,
} from '../../lib/constants';
import { canonicalSoundType as canonicalPriorityAlertSoundType } from '../../lib/format';
import { extractStudyID, parseStudyIDFromProlificURL, studyURLFromID } from './domain';

export interface PriorityActionsLimits {
  alertCooldownMS: number;
  maxAutoOpenPerBatch: number;
  maxAlertSoundVolume: number;
  minAlertSoundVolume: number;
  defaultAlertSoundVolume: number;
}

/**
 * How auto-open should behave for this batch:
 * - `focus`      — normal: focus the first opened tab (no submission in progress)
 * - `background` — open tabs without stealing focus (`active: false`)
 * - `skip`       — don't open any tabs
 */
export type AutoOpenFocusMode = 'focus' | 'background' | 'skip';

export interface CreatePriorityActionsOptions {
  nowIso: () => string;
  queryProlificTabs: () => Promise<Array<{ url?: string }>>;
  pushDebugLog: (event: string, details?: Record<string, unknown>) => void;
  bumpCounter: (key: string, amount: number) => Promise<void>;
  setState: (partial: Record<string, unknown>) => Promise<void>;
  limits: PriorityActionsLimits;
  playAudioFn?: ((soundType: string, volume: number) => Promise<void>) | null;
  // Resolves how auto-open should behave right now — used to avoid stealing focus
  // while the user is mid-submission (issue #21). Defaults to `focus`.
  resolveAutoOpenFocusMode?: () => Promise<AutoOpenFocusMode>;
}

export interface PriorityActions {
  handleAlertAction: (filter: PriorityFilter, candidateStudies: Study[], trigger: string) => Promise<void>;
  /**
   * Returns `true` when the batch was suppressed because a submission is in
   * progress (focus mode `skip`) and nothing was opened — the caller should NOT
   * mark these studies as auto-open-seen, so the opportunity survives once the
   * submission finishes. Returns `false` otherwise (opened, disabled, or no-op).
   */
  handleAutoOpenAction: (filter: PriorityFilter, candidateStudies: Study[], trigger: string) => Promise<boolean>;
  handleDesktopNotifyAction: (filter: PriorityFilter, candidateStudies: Study[], trigger: string) => Promise<void>;
}

export function createPriorityActions(options: CreatePriorityActionsOptions): PriorityActions {
  const {
    nowIso,
    queryProlificTabs,
    pushDebugLog,
    bumpCounter,
    setState,
    limits,
    playAudioFn,
    resolveAutoOpenFocusMode,
  } = options;

  let priorityAlertAudioContext: AudioContext | null = null;
  let priorityAlertPlayInFlight = false;
  let priorityAlertLastPlayedAt = 0;
  const priorityAlertSoundBase64PromiseByType = new Map<SoundType, Promise<string>>();
  let priorityAlertSoundBufferPromiseByType = new Map<SoundType, Promise<AudioBuffer>>();
  let priorityAlertSoundBufferContext: AudioContext | null = null;

  function getPriorityAlertAudioContext(): AudioContext | null {
    const AudioContextCtor = globalThis.AudioContext || (globalThis as unknown as Record<string, unknown>).webkitAudioContext as typeof AudioContext | undefined;
    if (!AudioContextCtor) {
      return null;
    }
    if (priorityAlertAudioContext) {
      return priorityAlertAudioContext;
    }
    try {
      priorityAlertAudioContext = new AudioContextCtor();
      return priorityAlertAudioContext;
    } catch {
      return null;
    }
  }

  function priorityAlertSoundBase64PathForType(soundType: unknown): string {
    const normalized = canonicalPriorityAlertSoundType(soundType);
    return PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH[normalized] || PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH[DEFAULT_PRIORITY_ALERT_SOUND_TYPE];
  }

  async function getPriorityAlertSoundBase64(soundType: unknown): Promise<string> {
    const normalized = canonicalPriorityAlertSoundType(soundType);
    if (!priorityAlertSoundBase64PromiseByType.has(normalized)) {
      const path = priorityAlertSoundBase64PathForType(normalized);
      priorityAlertSoundBase64PromiseByType.set(normalized, (async () => {
        const response = await fetch((browser.runtime as any).getURL(path));
        if (!response.ok) {
          throw new Error(`Failed to load ${normalized} sound.`);
        }
        return (await response.text()).replace(/\s+/g, '');
      })());
    }
    return priorityAlertSoundBase64PromiseByType.get(normalized)!;
  }

  async function getPriorityAlertSoundBuffer(audioContext: AudioContext, soundType: unknown): Promise<AudioBuffer> {
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
        const arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
        return audioContext.decodeAudioData(arrayBuffer);
      })());
    }
    return priorityAlertSoundBufferPromiseByType.get(normalized)!;
  }

  async function playDefaultPriorityAlertTone(soundType: unknown, soundVolume: unknown): Promise<SoundType> {
    const normalizedType = canonicalPriorityAlertSoundType(soundType);
    const normalizedVolume = Math.min(
      limits.maxAlertSoundVolume,
      Math.max(
        limits.minAlertSoundVolume,
        Number.parseInt(String(soundVolume), 10) || limits.defaultAlertSoundVolume,
      ),
    ) / 100;
    if (normalizedVolume <= 0) {
      return normalizedType;
    }

    // Chrome service worker path: delegate to offscreen document.
    if (typeof playAudioFn === 'function') {
      await playAudioFn(normalizedType, normalizedVolume);
      return normalizedType;
    }

    // Firefox path: use AudioContext directly.
    const audioContext = getPriorityAlertAudioContext();
    if (!audioContext) {
      throw new Error('audio context unavailable');
    }
    if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
      await audioContext.resume();
    }
    const startTime = audioContext.currentTime + 0.03;
    const soundBuffer = await getPriorityAlertSoundBuffer(audioContext, normalizedType);
    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    source.buffer = soundBuffer;
    source.loop = false;
    gainNode.gain.setValueAtTime(Math.max(0, Math.min(2.5, Math.pow(normalizedVolume, 0.55) * 2.2)), startTime);
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
    source.start(startTime);
    return normalizedType;
  }

  async function playPriorityAlertSound(trigger: string, studyCount: number, soundType: unknown, soundVolume: unknown): Promise<boolean> {
    const now = Date.now();
    if (priorityAlertPlayInFlight || now - priorityAlertLastPlayedAt < limits.alertCooldownMS) {
      return false;
    }

    priorityAlertPlayInFlight = true;
    try {
      const playedType = await playDefaultPriorityAlertTone(
        soundType,
        soundVolume,
      );

      priorityAlertLastPlayedAt = now;
      await bumpCounter('priority_alert_sound_count', 1);
      await setState({
        priority_alert_last_at: nowIso(),
        priority_alert_last_trigger: trigger,
        priority_alert_last_study_count: studyCount,
        priority_alert_sound_mode: playedType,
      });
      pushDebugLog('priority.alert.played', {
        trigger,
        study_count: studyCount,
        mode: playedType,
      });
      return true;
    } catch (error) {
      pushDebugLog('priority.alert.error', {
        trigger,
        error: String(error && (error as Error).message ? (error as Error).message : error),
      });
      return false;
    } finally {
      priorityAlertPlayInFlight = false;
    }
  }

  async function handleAlertAction(filter: PriorityFilter, candidateStudies: Study[], trigger: string): Promise<void> {
    if (!candidateStudies.length) {
      return;
    }
    if (filter.alert_sound_enabled === false) {
      pushDebugLog('priority.alert.disabled', {
        trigger,
        candidate_count: candidateStudies.length,
      });
      return;
    }
    await playPriorityAlertSound(
      trigger,
      candidateStudies.length,
      filter.alert_sound_type,
      filter.alert_sound_volume,
    );
  }

  async function handleAutoOpenAction(filter: PriorityFilter, candidateStudies: Study[], trigger: string): Promise<boolean> {
    if (!candidateStudies.length) {
      return false;
    }
    if (filter.auto_open_in_new_tab === false) {
      pushDebugLog('tab.priority_auto_open.disabled_new_tab', {
        trigger,
        candidate_count: candidateStudies.length,
      });
      return false;
    }

    // Don't steal focus while the user is mid-submission (issue #21). A failure
    // here (e.g. the DB read throwing) must not break auto-open — fall back to
    // normal focus behavior.
    let focusMode: AutoOpenFocusMode = 'focus';
    if (resolveAutoOpenFocusMode) {
      try {
        focusMode = await resolveAutoOpenFocusMode();
      } catch (error) {
        pushDebugLog('tab.priority_auto_open.focus_mode_error', {
          trigger,
          error: String(error && (error as Error).message ? (error as Error).message : error),
        });
      }
    }
    if (focusMode === 'skip') {
      pushDebugLog('tab.priority_auto_open.skipped_submission_in_progress', {
        trigger,
        candidate_count: candidateStudies.length,
      });
      // Suppressed by an in-progress submission — signal the caller not to mark
      // these studies seen, so they can still auto-open once the user finishes.
      return true;
    }
    const openInBackground = focusMode === 'background';

    const prolificTabs = await queryProlificTabs();
    const alreadyOpenStudyIDs = new Set<string>();
    for (const tab of prolificTabs) {
      const studyID = parseStudyIDFromProlificURL(tab && tab.url);
      if (studyID) {
        alreadyOpenStudyIDs.add(studyID);
      }
    }

    let openedCount = 0;
    for (const study of candidateStudies) {
      if (openedCount >= limits.maxAutoOpenPerBatch) {
        break;
      }

      const studyID = extractStudyID(study);
      if (!studyID || alreadyOpenStudyIDs.has(studyID)) {
        continue;
      }

      const studyURL = studyURLFromID(studyID);
      if (!studyURL) {
        continue;
      }

      await browser.tabs.create({
        url: studyURL,
        // Focus the first tab normally, but never steal focus mid-submission.
        active: openInBackground ? false : openedCount === 0,
      });

      alreadyOpenStudyIDs.add(studyID);
      openedCount += 1;
      pushDebugLog('tab.priority_auto_open.created', {
        trigger,
        study_id: studyID,
        study_name: study && study.name ? String(study.name) : '',
      });
    }

    if (!openedCount) {
      pushDebugLog('tab.priority_auto_open.skip_existing_tab', {
        trigger,
        candidate_count: candidateStudies.length,
      });
      return false;
    }

    await bumpCounter('priority_study_auto_open_count', openedCount);
    await setState({
      priority_study_auto_open_last_at: nowIso(),
      priority_study_auto_open_last_trigger: trigger,
      priority_study_auto_open_last_count: openedCount,
    });
    return false;
  }

  async function handleDesktopNotifyAction(filter: PriorityFilter, candidateStudies: Study[], trigger: string): Promise<void> {
    if (!candidateStudies.length) return;
    if (!filter.desktop_notify) {
      pushDebugLog('priority.desktop_notify.disabled', { trigger, candidate_count: candidateStudies.length });
      return;
    }

    const studyNames = candidateStudies.map((s) => s.name || s.id).slice(0, 5);
    const title = candidateStudies.length === 1
      ? 'New study available'
      : `${candidateStudies.length} new studies available`;
    const message = studyNames.join('\n');

    try {
      await browser.notifications.create(`pp-priority-${filter.id}-${Date.now()}`, {
        type: 'basic',
        iconUrl: (browser.runtime as any).getURL('icons/icon-96.png'),
        title,
        message,
      });
      await bumpCounter('priority_desktop_notify_count', 1);
      pushDebugLog('priority.desktop_notify.sent', { trigger, study_count: candidateStudies.length, filter: filter.name });
    } catch (error) {
      pushDebugLog('priority.desktop_notify.error', { trigger, error: String(error && (error as Error).message ? (error as Error).message : error) });
    }
  }

  return Object.freeze({
    handleAlertAction,
    handleAutoOpenAction,
    handleDesktopNotifyAction,
  });
}
