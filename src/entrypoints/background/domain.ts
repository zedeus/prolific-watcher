import type { Study, PriorityFilter, Money, ResearcherRef } from '../../lib/types';
import { SOUND_TYPE_NONE, STUDY_TYPE_SCREENING, STUDY_TYPE_ONGOING, STUDY_TYPE_STANDARD } from '../../lib/constants';
import { moneyMajorValue, studyUrlFromId, trimString } from '../../lib/format';

function extractStudiesResults(payload: unknown): Study[] | null {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).results)) {
    return null;
  }
  return (payload as Record<string, unknown>).results as Study[];
}

export function extractStudyID(study: Study | null | undefined): string {
  return study?.id?.trim() ?? '';
}

export function studyHourlyRewardMajor(study: Study | null | undefined): number {
  const s = study as any;
  const hourly = s && typeof s === 'object'
    ? (s.study_average_reward_per_hour || s.average_reward_per_hour)
    : null;
  return moneyMajorValue(hourly as Money | null | undefined);
}

export function studyRewardMajor(study: Study | null | undefined): number {
  const s = study as any;
  const reward = s && typeof s === 'object'
    ? (s.study_reward || s.reward)
    : null;
  return moneyMajorValue(reward as Money | null | undefined);
}

export function studyEstimatedMinutes(study: Study | null | undefined): number {
  const s = study as any;
  const raw = s && (s.estimated_completion_time ?? (Number(s.average_completion_time_in_seconds) / 60));
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) {
    return NaN;
  }
  return minutes;
}

export function studyPlacesAvailable(study: Study | null | undefined): number {
  const explicit = Number(study && study.places_available);
  if (Number.isFinite(explicit)) {
    return explicit;
  }
  const total = Number(study && study.total_available_places);
  const taken = Number(study && study.places_taken);
  if (!Number.isFinite(total)) {
    return NaN;
  }
  if (!Number.isFinite(taken)) {
    return total;
  }
  return Math.max(0, total - taken);
}

export function studyKeywordBlob(study: Study | null | undefined): string {
  const labels = Array.isArray(study?.study_labels) ? study!.study_labels : [];
  const inferred = Array.isArray(study?.ai_inferred_study_labels) ? study!.ai_inferred_study_labels : [];
  return [
    study && study.name ? study.name : '',
    study && study.description ? study.description : '',
    ...labels,
    ...inferred,
  ].join(' ').toLowerCase();
}

function hasAnyPriorityKeywordMatch(keywordBlob: string, keywords: string[]): boolean {
  if (!Array.isArray(keywords) || !keywords.length) {
    return false;
  }
  return keywords.some((keyword) => keywordBlob.includes(keyword));
}

function studyMatchesResearcherList(study: Study, list: ResearcherRef[] | undefined): boolean {
  if (!Array.isArray(list) || !list.length) return false;
  const id = trimString(study?.researcher?.id);
  if (!id) return false;
  return list.some((ref) => ref && typeof ref.id === 'string' && ref.id === id);
}

export function studyTypeCategory(study: Study | null | undefined): string {
  if (study?.is_custom_screening) return STUDY_TYPE_SCREENING;
  if (study?.is_ongoing_study) return STUDY_TYPE_ONGOING;
  return STUDY_TYPE_STANDARD;
}

function studyMatchesIDList(study: Study, list: string[] | undefined): boolean {
  if (!Array.isArray(list) || !list.length) return false;
  const id = extractStudyID(study);
  if (!id) return false;
  return list.includes(id);
}

export function studyMatchesPriorityFilter(study: Study, filter: PriorityFilter, precomputedBlob?: string): boolean {
  // Block lists (highest-priority exclusions)
  if (studyMatchesResearcherList(study, filter.ignore_researchers)) {
    return false;
  }
  if (studyMatchesIDList(study, filter.ignore_study_ids)) {
    return false;
  }
  const keywordBlob = precomputedBlob ?? studyKeywordBlob(study);
  if (hasAnyPriorityKeywordMatch(keywordBlob, filter.ignore_keywords)) {
    return false;
  }

  // Match lists are whitelists: when any is non-empty, the filter scopes to
  // studies matching at least one entry. All empty = no scope restriction.
  const hasResearcherScope = Array.isArray(filter.match_researchers) && filter.match_researchers.length > 0;
  const hasKeywordScope = Array.isArray(filter.match_keywords) && filter.match_keywords.length > 0;
  const hasStudyIDScope = Array.isArray(filter.match_study_ids) && filter.match_study_ids.length > 0;
  if (hasResearcherScope || hasKeywordScope || hasStudyIDScope) {
    const researcherMatched = hasResearcherScope && studyMatchesResearcherList(study, filter.match_researchers);
    const keywordMatched = hasKeywordScope && hasAnyPriorityKeywordMatch(keywordBlob, filter.match_keywords);
    const studyIDMatched = hasStudyIDScope && studyMatchesIDList(study, filter.match_study_ids);
    if (!researcherMatched && !keywordMatched && !studyIDMatched) {
      return false;
    }
  }

  // Study type restriction
  const allowedTypes = filter.allowed_study_types;
  if (Array.isArray(allowedTypes) && allowedTypes.length > 0) {
    if (!allowedTypes.includes(studyTypeCategory(study))) {
      return false;
    }
  }

  const reward = studyRewardMajor(study);
  if (!Number.isFinite(reward) || reward < filter.minimum_reward_major) {
    return false;
  }

  const hourly = studyHourlyRewardMajor(study);
  if (!Number.isFinite(hourly) || hourly < filter.minimum_hourly_reward_major) {
    return false;
  }

  const estimatedMinutes = studyEstimatedMinutes(study);
  if (!Number.isFinite(estimatedMinutes) || estimatedMinutes > filter.maximum_estimated_minutes) {
    return false;
  }

  if (filter.minimum_estimated_minutes > 0 && estimatedMinutes < filter.minimum_estimated_minutes) {
    return false;
  }

  const placesAvailable = studyPlacesAvailable(study);
  if (!Number.isFinite(placesAvailable) || placesAvailable < filter.minimum_places_available) {
    return false;
  }
  return true;
}

/** When multiple filters match the same study, the highest-scoring filter wins. */
function filterImportanceScore(study: Study, keywordBlob: string, filter: PriorityFilter, filterIndex: number): number {
  let score = 0;

  // Whitelist-scoped filters are more specific than open filters — give them
  // priority when multiple filters match the same study.
  if (
    hasAnyPriorityKeywordMatch(keywordBlob, filter.match_keywords) ||
    studyMatchesResearcherList(study, filter.match_researchers) ||
    studyMatchesIDList(study, filter.match_study_ids)
  ) {
    score += 1000;
  }

  if (filter.auto_open_in_new_tab) score += 100;
  if (filter.alert_sound_enabled && filter.alert_sound_type !== SOUND_TYPE_NONE) score += 100;

  score += filter.alert_sound_volume;

  score += Math.min(20, filter.minimum_reward_major * 0.2);
  score += Math.min(20, filter.minimum_hourly_reward_major * 0.2);
  score += Math.max(0, (240 - filter.maximum_estimated_minutes) / 240) * 20;

  score += Math.max(0, 10 - filterIndex * 0.1);

  return score;
}

export function parseStudyIDFromProlificURL(rawURL: string | null | undefined): string {
  if (!rawURL || typeof rawURL !== 'string') {
    return '';
  }
  try {
    const parsed = new URL(rawURL);
    const match = parsed.pathname.match(/^\/studies\/([^/]+)\/?$/);
    if (!match || !match[1]) {
      return '';
    }
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

export function studyURLFromID(studyID: string | null | undefined): string {
  const id = typeof studyID === 'string' ? studyID.trim() : '';
  if (!id) return '';
  return studyUrlFromId(id);
}

export function parseTimestampMS(value: unknown, fallbackMS: number = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  const parsed = Date.parse(String(value || ''));
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallbackMS;
}

function normalizeStudyIDList(rawStudyIDs: unknown): string[] {
  if (!Array.isArray(rawStudyIDs) || !rawStudyIDs.length) {
    return [];
  }
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const rawStudyID of rawStudyIDs) {
    const studyID = typeof rawStudyID === 'string' ? rawStudyID.trim() : '';
    if (!studyID || seen.has(studyID)) {
      continue;
    }
    seen.add(studyID);
    unique.push(studyID);
  }
  return unique;
}

interface StudiesSnapshot {
  studyIDs: Set<string>;
  studiesByID: Map<string, Study>;
}

function buildPriorityStudiesSnapshotFromStudies(studies: Study[] | unknown): StudiesSnapshot {
  const studiesByID = new Map<string, Study>();
  if (Array.isArray(studies)) {
    for (const study of studies) {
      const studyID = extractStudyID(study);
      if (!studyID || studiesByID.has(studyID)) {
        continue;
      }
      studiesByID.set(studyID, study);
    }
  }
  return {
    studyIDs: new Set(studiesByID.keys()),
    studiesByID,
  };
}

function sortPriorityStudies(studies: Study[]): Study[] {
  return studies.slice().sort((a, b) => {
    const hourlyDiff = studyHourlyRewardMajor(b) - studyHourlyRewardMajor(a);
    if (Number.isFinite(hourlyDiff) && hourlyDiff !== 0) {
      return hourlyDiff;
    }
    const placesDiff = studyPlacesAvailable(b) - studyPlacesAvailable(a);
    if (Number.isFinite(placesDiff) && placesDiff !== 0) {
      return placesDiff;
    }
    const aID = extractStudyID(a);
    const bID = extractStudyID(b);
    return aID.localeCompare(bID);
  });
}

export interface NormalizedSnapshotEvent {
  mode: 'full' | 'delta';
  trigger: string;
  observedAtMS: number;
  studies: Study[];
  removedStudyIDs: string[];
}

export interface SnapshotState {
  initialized: boolean;
  knownStudyIDs: Set<string>;
}

interface SnapshotEvaluationResult {
  event: NormalizedSnapshotEvent;
  nextSnapshot: SnapshotState;
  newlySeenStudies: Study[];
  matchesByFilterId: Map<string, Study[]>;
  enabledFilters: { filter: PriorityFilter; index: number }[];
  isBaseline: boolean;
}

export function normalizePrioritySnapshotEvent(event: unknown): NormalizedSnapshotEvent {
  const e = event as Record<string, unknown> | null | undefined;
  const mode = e && e.mode === 'delta' ? 'delta' as const : 'full' as const;
  return {
    mode,
    trigger: String((e && e.trigger) || 'unknown'),
    observedAtMS: parseTimestampMS(e && (e.observedAtMS ?? e.observedAt)),
    studies: Array.isArray(e?.studies) ? e!.studies as Study[] : [],
    removedStudyIDs: normalizeStudyIDList(e && e.removedStudyIDs),
  };
}

export function evaluatePrioritySnapshotEvent(
  previousSnapshot: SnapshotState | null | undefined,
  rawEvent: unknown,
  filters: PriorityFilter[],
): SnapshotEvaluationResult {
  const event = normalizePrioritySnapshotEvent(rawEvent);
  const priorStudyIDs = previousSnapshot && previousSnapshot.knownStudyIDs instanceof Set
    ? new Set(previousSnapshot.knownStudyIDs)
    : new Set<string>();
  const wasInitialized = previousSnapshot && previousSnapshot.initialized === true;

  let nextStudyIDs = new Set(priorStudyIDs);
  const newlySeenStudies: Study[] = [];

  if (event.mode === 'delta') {
    for (const removedStudyID of event.removedStudyIDs) {
      nextStudyIDs.delete(removedStudyID);
    }

    const addedSnapshot = buildPriorityStudiesSnapshotFromStudies(event.studies);
    for (const [studyID, study] of addedSnapshot.studiesByID.entries()) {
      if (!nextStudyIDs.has(studyID)) {
        newlySeenStudies.push(study);
      }
      nextStudyIDs.add(studyID);
    }
  } else {
    const fullSnapshot = buildPriorityStudiesSnapshotFromStudies(event.studies);
    nextStudyIDs = fullSnapshot.studyIDs;
    for (const [studyID, study] of fullSnapshot.studiesByID.entries()) {
      if (!priorStudyIDs.has(studyID)) {
        newlySeenStudies.push(study);
      }
    }
  }

  const isBaseline = event.mode === 'full' && !wasInitialized;
  const matchesByFilterId = new Map<string, Study[]>();
  const enabledFilters = filters
    .map((f, i) => ({ filter: f, index: i }))
    .filter(({ filter }) => filter.enabled);

  if (!isBaseline && newlySeenStudies.length && enabledFilters.length) {
    for (const study of newlySeenStudies) {
      const blob = studyKeywordBlob(study);
      let bestFilterId = '';
      let bestScore = -1;

      for (const { filter, index } of enabledFilters) {
        if (!studyMatchesPriorityFilter(study, filter, blob)) continue;
        const score = filterImportanceScore(study, blob, filter, index);
        if (score > bestScore) {
          bestScore = score;
          bestFilterId = filter.id;
        }
      }

      if (bestFilterId) {
        const list = matchesByFilterId.get(bestFilterId);
        if (list) {
          list.push(study);
        } else {
          matchesByFilterId.set(bestFilterId, [study]);
        }
      }
    }

    for (const [filterId, studies] of matchesByFilterId) {
      matchesByFilterId.set(filterId, sortPriorityStudies(studies));
    }
  }

  return {
    event,
    nextSnapshot: {
      initialized: true,
      knownStudyIDs: nextStudyIDs,
    },
    newlySeenStudies,
    matchesByFilterId,
    enabledFilters,
    isBaseline,
  };
}

interface RawSnapshotEvent {
  mode: 'full' | 'delta';
  trigger: string;
  observedAt?: string;
  studies: Study[];
  removedStudyIDs: string[];
}

interface FullSnapshotContext {
  normalizedURL?: string;
  observedAt?: string;
}

export function toFullSnapshotEvent(
  parsed: unknown,
  context: FullSnapshotContext | null | undefined,
  nowIso: () => string,
): RawSnapshotEvent | null {
  const studies = extractStudiesResults(parsed);
  if (!studies) {
    return null;
  }
  return {
    mode: 'full',
    trigger: context && context.normalizedURL
      ? String(context.normalizedURL)
      : 'studies.response.capture',
    observedAt: context && context.observedAt ? context.observedAt : nowIso(),
    studies,
    removedStudyIDs: [],
  };
}
