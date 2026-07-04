import { db } from './db';
import { extractSubmissionReward, extractStartedAt } from './earnings';
import { nowIso, trimString, formatStudyLabel } from './format';
import { CSV_SUBMISSION_ID_PREFIX } from './import-csv';
import { researcherRefFromPayload } from './submission-analytics';
import { computeStudyHistoryInsights, redundantHistoryRowIds, buildObservations, type StudyHistoryInsights, type Observations } from './study-history';
import {
  INSIGHTS_MAX_HISTORY_ROWS,
  INSIGHTS_MAX_EVENTS,
  INSIGHTS_MAX_OBSERVATIONS,
  INSIGHTS_SECTION_LIMIT,
  OBSERVATION_MIN_SPACING_MS,
  STUDY_HISTORY_RETENTION_DAYS,
} from './constants';
import type {
  StudyLatestRecord,
  StudyActiveSnapshotRecord,
  StudyAvailabilityEventRecord,
  SubmissionRecord,
  ResearcherRecord,
} from './db';
import type {
  Study,
  StudyEvent,
  Submission,
  StudiesRefreshState,
  Researcher,
} from './types';
import type { SubmissionSnapshot } from './normalize';

// --- Service State ---

interface StudiesRefreshUpdate {
  observed_at: string;
  source: string;
  url: string;
  status_code: number;
}

export async function setStudiesRefresh(update: StudiesRefreshUpdate): Promise<void> {
  await db.serviceState.put({
    id: 1,
    last_studies_refresh_at: update.observed_at,
    last_studies_refresh_source: update.source,
    last_studies_refresh_url: update.url,
    last_studies_refresh_status: update.status_code,
    updated_at: nowIso(),
  });
}

// --- Study-history insights (issue #19) ---

/**
 * Load the study-history Insights view-model: price moves, fill speed, posting cadence, and reruns.
 * Reads the most-recent slice of studiesHistory + availability events + observation-log heartbeats (all
 * bounded — compaction keeps the tables small) and computes everything in one pass so the popup holds
 * only the compact result.
 */
export async function getStudyInsights(): Promise<StudyHistoryInsights> {
  const [history, events, observations] = await Promise.all([
    db.studiesHistory.orderBy('row_id').reverse().limit(INSIGHTS_MAX_HISTORY_ROWS).toArray(),
    db.studyAvailabilityEvents.orderBy('row_id').reverse().limit(INSIGHTS_MAX_EVENTS).toArray(),
    db.observationLog.orderBy('id').reverse().limit(INSIGHTS_MAX_OBSERVATIONS).toArray(),
  ]);
  return computeStudyHistoryInsights(history, events, {
    fastestLimit: INSIGHTS_SECTION_LIMIT,
    observationTimes: observations.map((o) => o.at),
  });
}

/**
 * Compact studiesHistory: drop snapshots older than the retention window, then drop strictly-redundant
 * consecutive snapshots (unchanged reward/hourly/places between neighbours). Change-points and each
 * study's endpoints are always kept, so analytics are unaffected. Also ages out the observation log
 * (never compacted, only aged). Returns rows deleted.
 */
export async function pruneStudyHistory(now: Date = new Date()): Promise<number> {
  const cutoffIso = new Date(now.getTime() - STUDY_HISTORY_RETENTION_DAYS * 86_400_000).toISOString();
  return db.transaction('rw', [db.studiesHistory, db.observationLog], async () => {
    const aged = (await db.studiesHistory.where('observed_at').below(cutoffIso).primaryKeys()) as number[];
    if (aged.length) await db.studiesHistory.bulkDelete(aged);
    const remaining = await db.studiesHistory.toArray();
    const redundant = redundantHistoryRowIds(remaining);
    if (redundant.length) await db.studiesHistory.bulkDelete(redundant);

    const agedObs = (await db.observationLog.where('at').below(cutoffIso).primaryKeys()) as number[];
    if (agedObs.length) await db.observationLog.bulkDelete(agedObs);

    return aged.length + redundant.length + agedObs.length;
  });
}

/**
 * Emergency backstop for storage pressure (issue #25): drop the oldest studiesHistory rows so at most
 * `maxRows` most-recent remain. Unlike pruneStudyHistory (age + redundancy, analytics-preserving) this
 * caps raw row count regardless of age, trading Insights depth for staying under quota. Rows are keyed
 * by the auto-increment `row_id`, so "oldest" == smallest ids. Returns rows deleted.
 */
export async function pruneStudyHistoryToRowCap(maxRows: number): Promise<number> {
  const cap = Math.max(0, Math.floor(maxRows));
  return db.transaction('rw', [db.studiesHistory], async () => {
    const total = await db.studiesHistory.count();
    if (total <= cap) return 0;
    const toDelete = total - cap;
    const oldest = (await db.studiesHistory.orderBy('row_id').limit(toDelete).primaryKeys()) as number[];
    if (oldest.length) await db.studiesHistory.bulkDelete(oldest);
    return oldest.length;
  });
}

/**
 * Record a "we observed the studies feed at this instant" heartbeat — even when the feed was empty.
 * Downsampled: refreshes within OBSERVATION_MIN_SPACING_MS of the last heartbeat are skipped, so the
 * log stays coarse enough to span months (within the load cap) while still dense enough that the
 * appearance check finds a heartbeat within RELIABLE_OBSERVATION_GAP_MS before any real drop.
 */
export async function recordObservation(at: string): Promise<void> {
  const last = await db.observationLog.orderBy('id').last();
  if (last) {
    const gap = Date.parse(at) - Date.parse(last.at);
    if (Number.isFinite(gap) && gap >= 0 && gap < OBSERVATION_MIN_SPACING_MS) return;
  }
  await db.observationLog.add({ at });
}

export async function getStudiesRefresh(): Promise<StudiesRefreshState | null> {
  const row = await db.serviceState.get(1);
  if (!row || !row.last_studies_refresh_at) return null;
  return {
    last_studies_refresh_at: row.last_studies_refresh_at,
    last_studies_refresh_source: row.last_studies_refresh_source,
    last_studies_refresh_url: row.last_studies_refresh_url,
    last_studies_refresh_status: row.last_studies_refresh_status,
  };
}

// --- Studies ---

export async function storeNormalizedStudies(studies: Study[], observedAt: string): Promise<void> {
  if (studies.length === 0) return;

  // The studies/history/researcher tables are disjoint, so we run the
  // researcher upsert in parallel with the studies+history transaction
  // rather than after it — avoids an extra round-trip on the ingest hot path.
  await Promise.all([
    db.transaction('rw', [db.studiesHistory, db.studiesLatest], async () => {
      const historyRecords = studies.map((study) => ({
        study_id: study.id,
        observed_at: observedAt,
        payload: study as unknown as Record<string, unknown>,
      }));
      await db.studiesHistory.bulkAdd(historyRecords);

      const latestRecords: StudyLatestRecord[] = studies.map((study) => ({
        study_id: study.id,
        name: study.name,
        payload: study as unknown as Record<string, unknown>,
        last_seen_at: observedAt,
      }));
      await db.studiesLatest.bulkPut(latestRecords);
    }),
    upsertResearchersFromStudies(studies, observedAt),
  ]);
}

/**
 * Build a `study_id → display study-type label` map from every study we've observed.
 * Used to label earnings by study type (submissions don't carry labels themselves).
 * Studies with no usable label are omitted, so callers should fall back to "Other".
 */
export async function getStudyTypeMap(): Promise<Map<string, string>> {
  const rows = await db.studiesLatest.toArray();
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.study_id) continue;
    const p = row.payload as Partial<Study> | undefined;
    // Defensive: payloads may predate the current schema or be hand-imported — only feed clean
    // string labels to formatStudyLabel, which would otherwise throw on a non-string element.
    const label = formatStudyLabel(stringArray(p?.study_labels), stringArray(p?.ai_inferred_study_labels));
    if (label) map.set(row.study_id, label);
  }
  return map;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

// --- Researchers ---

function dedupeResearchersById(researchers: (Researcher | null | undefined)[]): Map<string, Researcher> {
  const map = new Map<string, Researcher>();
  for (const r of researchers) {
    if (!r || typeof r !== 'object') continue;
    const id = trimString(r.id);
    if (!id) continue;
    const existing = map.get(id);
    map.set(id, {
      id,
      name: trimString(r.name) || existing?.name || '',
      country: trimString(r.country) || existing?.country || '',
    });
  }
  return map;
}

// Counts on persisted researcher records are always 0. The picker computes the
// live counts at read-time via annotateResearcherCounts() by joining against
// in-memory studies + submissions — that way the numbers reflect reality
// instead of per-observation increments (which over-counted every refresh).
function mergedResearcherRecord(
  id: string,
  fresh: Researcher,
  prior: ResearcherRecord | undefined,
  observedAt: string,
): ResearcherRecord | null {
  const name = fresh.name || prior?.name || '';
  const country = fresh.country || prior?.country || '';
  const priorLast = prior?.last_seen_at ?? '';
  const nextLast = observedAt > priorLast ? observedAt : priorLast;
  // No-op guard: if nothing changed, skip the write entirely.
  if (prior && prior.name === name && prior.country === country && prior.last_seen_at === nextLast) {
    return null;
  }
  return {
    id,
    name,
    country,
    first_seen_at: prior?.first_seen_at ?? observedAt,
    last_seen_at: nextLast,
    study_count: 0,
    submission_count: 0,
  };
}

export async function upsertResearchersFromStudies(studies: Study[], observedAt: string): Promise<void> {
  const fresh = dedupeResearchersById(studies.map((s) => s?.researcher));
  if (fresh.size === 0) return;

  await db.transaction('rw', db.researchers, async () => {
    const existing = await db.researchers.bulkGet([...fresh.keys()]);
    const updates: ResearcherRecord[] = [];
    let idx = 0;
    for (const [id, researcher] of fresh) {
      const merged = mergedResearcherRecord(id, researcher, existing[idx++], observedAt);
      if (merged) updates.push(merged);
    }
    if (updates.length) await db.researchers.bulkPut(updates);
  });
}

export async function upsertResearcherFromSubmission(
  rawPayload: unknown,
  observedAt: string,
): Promise<void> {
  const researcher = extractResearcherFromSubmissionPayload(rawPayload);
  if (!researcher) return;

  await db.transaction('rw', db.researchers, async () => {
    const prior = await db.researchers.get(researcher.id);
    const merged = mergedResearcherRecord(researcher.id, researcher, prior, observedAt);
    if (merged) await db.researchers.put(merged);
  });
}

export function extractResearcherFromSubmissionPayload(rawPayload: unknown): Researcher | null {
  // Shared implementation lives in submission-analytics (DB-free); kept as a named re-export here
  // because store is the historical import site (SubmissionDetail/SubmissionsPanel, ingest path).
  return researcherRefFromPayload(rawPayload);
}

export interface ResearcherStudyData {
  researcher: ResearcherRecord | null;
  studies: Study[];
  availabilityEvents: StudyAvailabilityEventRecord[];
  /** Observation timeline for this researcher's studies, so "typically listed" ignores unwatched gaps. */
  observations: Observations;
}

/**
 * Gather a researcher's study-history context for a profile: their researcher record, every study
 * we've observed from them (from `studiesLatest`, which retains all study ids ever seen), and the
 * availability events for those studies. Submissions are joined separately by the caller (the popup
 * already holds the full analytics set in memory).
 */
export async function getResearcherStudyData(researcherId: string): Promise<ResearcherStudyData> {
  const id = trimString(researcherId);
  if (!id) return { researcher: null, studies: [], availabilityEvents: [], observations: buildObservations([]) };

  const [researcher, latestRows] = await Promise.all([
    db.researchers.get(id),
    db.studiesLatest.toArray(),
  ]);

  const studies: Study[] = [];
  const studyIds: string[] = [];
  for (const row of latestRows) {
    const study = row.payload as unknown as Study;
    if (trimString(study?.researcher?.id) === id) {
      studies.push(study);
      studyIds.push(row.study_id);
    }
  }

  const [availabilityEvents, history] = studyIds.length > 0
    ? await Promise.all([
        db.studyAvailabilityEvents.where('study_id').anyOf(studyIds).toArray(),
        db.studiesHistory.where('study_id').anyOf(studyIds).toArray(),
      ])
    : [[], []];

  return { researcher: researcher ?? null, studies, availabilityEvents, observations: buildObservations(history) };
}

export async function listKnownResearchers(): Promise<ResearcherRecord[]> {
  const all = await db.researchers.toArray();
  all.sort((a, b) => {
    const cmp = (b.last_seen_at || '').localeCompare(a.last_seen_at || '');
    if (cmp !== 0) return cmp;
    return (a.name || '').localeCompare(b.name || '');
  });
  return all;
}

/**
 * Annotate researcher records with live study/submission counts computed from
 * the arrays the caller already has. Avoids re-reading those tables on every
 * popup refresh tick.
 */
export function annotateResearcherCounts(
  researchers: ResearcherRecord[],
  studies: Study[],
  submissions: SubmissionRecord[],
): ResearcherRecord[] {
  const studyCounts = new Map<string, number>();
  for (const s of studies) {
    const id = trimString(s?.researcher?.id);
    if (!id) continue;
    studyCounts.set(id, (studyCounts.get(id) ?? 0) + 1);
  }
  const submissionCounts = new Map<string, number>();
  for (const sub of submissions) {
    const id = extractResearcherFromSubmissionPayload(sub.payload)?.id;
    if (!id) continue;
    submissionCounts.set(id, (submissionCounts.get(id) ?? 0) + 1);
  }
  return researchers.map((r) => ({
    ...r,
    study_count: studyCounts.get(r.id) ?? 0,
    submission_count: submissionCounts.get(r.id) ?? 0,
  }));
}

interface StudyChange {
  study_id: string;
  name: string;
}

export interface AvailabilitySummary {
  observed_at: string;
  newly_available: StudyChange[];
  became_unavailable: StudyChange[];
}

/**
 * Compare current studies against the active snapshot to detect availability changes.
 * Port of StudiesStore.ReconcileAvailability from stores.go:400-487.
 */
export async function reconcileAvailability(studies: Study[], observedAt: string): Promise<AvailabilitySummary> {
  const currentMap = new Map<string, string>();
  for (const study of studies) {
    if (study.id) currentMap.set(study.id, study.name);
  }

  const summary: AvailabilitySummary = {
    observed_at: observedAt,
    newly_available: [],
    became_unavailable: [],
  };

  await db.transaction('rw', [db.studiesActiveSnapshot, db.studyAvailabilityEvents], async () => {
    const previousEntries = await db.studiesActiveSnapshot.toArray();
    const previousMap = new Map<string, { name: string; first_seen_at: string }>();
    for (const entry of previousEntries) {
      previousMap.set(entry.study_id, { name: entry.name, first_seen_at: entry.first_seen_at });
    }

    const newEvents: { study_id: string; study_name: string; event_type: 'available' | 'unavailable'; observed_at: string }[] = [];
    for (const [id, name] of currentMap) {
      if (!previousMap.has(id)) {
        summary.newly_available.push({ study_id: id, name });
        newEvents.push({ study_id: id, study_name: name, event_type: 'available', observed_at: observedAt });
      }
    }
    for (const [id, prev] of previousMap) {
      if (!currentMap.has(id)) {
        summary.became_unavailable.push({ study_id: id, name: prev.name });
        newEvents.push({ study_id: id, study_name: prev.name, event_type: 'unavailable', observed_at: observedAt });
      }
    }
    if (newEvents.length > 0) {
      await db.studyAvailabilityEvents.bulkAdd(newEvents);
    }

    const departedIDs = [...previousMap.keys()].filter((id) => !currentMap.has(id));
    if (departedIDs.length > 0) {
      await db.studiesActiveSnapshot.bulkDelete(departedIDs);
    }

    const upsertRecords: StudyActiveSnapshotRecord[] = [];
    for (const [id, name] of currentMap) {
      const prev = previousMap.get(id);
      upsertRecords.push({
        study_id: id,
        name,
        first_seen_at: prev?.first_seen_at ?? observedAt,
        last_seen_at: observedAt,
      });
    }
    if (upsertRecords.length > 0) {
      await db.studiesActiveSnapshot.bulkPut(upsertRecords);
    }
  });

  // Sort for deterministic output (matches Go sort)
  summary.newly_available.sort((a, b) => a.study_id.localeCompare(b.study_id));
  summary.became_unavailable.sort((a, b) => a.study_id.localeCompare(b.study_id));

  return summary;
}

/**
 * Get recent availability events enriched with study data.
 * Port of StudiesStore.GetRecentAvailabilityEvents from stores.go:489-532.
 */
export async function getRecentAvailabilityEvents(limit: number): Promise<StudyEvent[]> {
  limit = clamp(limit, 50, 1000);

  const eventRecords = await db.studyAvailabilityEvents
    .orderBy('row_id')
    .reverse()
    .limit(limit)
    .toArray();

  // Batch load related studies to avoid N+1 queries
  const studyIds = [...new Set(eventRecords.map((r) => r.study_id))];
  const studyRecords = await db.studiesLatest
    .where('study_id')
    .anyOf(studyIds)
    .toArray();
  const studyMap = new Map(studyRecords.map((r) => [r.study_id, r.payload as unknown as Study]));

  return eventRecords.map((record) => {
    const study = studyMap.get(record.study_id);
    return {
      row_id: record.row_id!,
      study_id: record.study_id,
      study_name: record.study_name,
      event_type: record.event_type,
      observed_at: record.observed_at,
      reward: study?.reward ?? { amount: 0, currency: '' },
      average_reward_per_hour: study?.average_reward_per_hour ?? { amount: 0, currency: '' },
      estimated_completion_time: study?.estimated_completion_time ?? 0,
      total_available_places: study?.total_available_places ?? 0,
      places_available: study?.places_available ?? 0,
      researcher_name: study?.researcher?.name?.trim() ?? '',
      researcher_id: study?.researcher?.id?.trim() ?? '',
    };
  });
}

/**
 * Get currently available studies sorted by first_seen_at.
 * Port of StudiesStore.GetCurrentAvailableStudies from stores.go:534-573.
 */
export async function getCurrentAvailableStudies(limit: number): Promise<Study[]> {
  limit = clamp(limit, 200, 2000);

  const snapshots = await db.studiesActiveSnapshot.toArray();

  // Batch load related studies to avoid N+1 queries
  const snapshotIds = snapshots.map((s) => s.study_id);
  const latestRecords = await db.studiesLatest
    .where('study_id')
    .anyOf(snapshotIds)
    .toArray();
  const latestMap = new Map(latestRecords.map((r) => [r.study_id, r.payload as unknown as Study]));

  const joined: { snapshot: StudyActiveSnapshotRecord; study: Study }[] = [];
  for (const snapshot of snapshots) {
    const study = latestMap.get(snapshot.study_id);
    if (!study) continue;
    joined.push({ snapshot, study });
  }

  // Sort: first_seen_at ASC, published_at ASC, date_created ASC, study_id ASC
  joined.sort((a, b) => {
    const cmp1 = a.snapshot.first_seen_at.localeCompare(b.snapshot.first_seen_at);
    if (cmp1 !== 0) return cmp1;
    const cmp2 = (a.study.published_at ?? '').localeCompare(b.study.published_at ?? '');
    if (cmp2 !== 0) return cmp2;
    const cmp3 = (a.study.date_created ?? '').localeCompare(b.study.date_created ?? '');
    if (cmp3 !== 0) return cmp3;
    return a.snapshot.study_id.localeCompare(b.snapshot.study_id);
  });

  return joined.slice(0, limit).map(({ snapshot, study }) => ({
    ...study,
    first_seen_at: snapshot.first_seen_at,
  }));
}

// --- Submissions ---

/**
 * Upsert a submission with smart merge logic.
 * Port of SubmissionsStore.UpsertSnapshot from stores.go:157-256.
 */
export async function upsertSubmission(snapshot: SubmissionSnapshot, observedAt: string): Promise<void> {
  // snapshot.status is already normalized by buildSubmissionSnapshot
  const status = snapshot.status;
  if (!status) throw new Error('missing status');
  const phase = snapshot.phase;

  const studyID = snapshot.study_id;
  const studyName = snapshot.study_name;
  const participantID = snapshot.participant_id;
  const payload = snapshot.payload && typeof snapshot.payload === 'object' ? snapshot.payload : {};
  const updatedAt = nowIso();

  // Submissions and researchers are disjoint stores, so we can run the
  // researcher upsert in parallel with the submissions transaction.
  const submissionWrite = db.transaction('rw', db.submissions, async () => {
    const existing = await db.submissions.get(snapshot.submission_id);

    if (!existing) {
      // First time seeing this submission id live → drop any CSV-imported stub
      // that represents the same submission. The stub id may be either
      // csv:{study_code} (when the CSV had a completion code) or
      // csv:{slug}:{timestamp} (when it didn't — Prolific omits the code for
      // some RETURNED rows), so we match by both.
      await deleteCsvDupes({ study_name: studyName, payload }, phase);
      const record: SubmissionRecord = {
        submission_id: snapshot.submission_id,
        study_id: studyID,
        study_name: studyName,
        participant_id: participantID,
        status,
        phase,
        payload,
        observed_at: observedAt,
        updated_at: updatedAt,
      };
      await db.submissions.add(record);
      return;
    }

    // Merge logic matching Go UPSERT ON CONFLICT
    const mergedStudyID = (studyID && studyID !== 'unknown') ? studyID : existing.study_id;
    const mergedStudyName = (studyName && studyName !== 'Unknown Study') ? studyName : existing.study_name;
    const mergedParticipantID = participantID || existing.participant_id;

    // Preserve payload when: both phases are 'submitted', old has completed_at/returned_at, new doesn't
    let mergedPayload = payload;
    if (existing.phase === phase && phase === 'submitted') {
      const oldPayload = existing.payload as Record<string, unknown>;
      const oldHasTimestamp = oldPayload.returned_at != null || oldPayload.completed_at != null;
      const newHasTimestamp = payload.returned_at != null || payload.completed_at != null;
      if (oldHasTimestamp && !newHasTimestamp) {
        mergedPayload = existing.payload;
      }
    }

    // Preserve observed_at when both phases are 'submitted'
    const mergedObservedAt = (existing.phase === phase && phase === 'submitted')
      ? existing.observed_at
      : observedAt;

    await db.submissions.put({
      submission_id: snapshot.submission_id,
      study_id: mergedStudyID,
      study_name: mergedStudyName,
      participant_id: mergedParticipantID,
      status,
      phase,
      payload: mergedPayload,
      observed_at: mergedObservedAt,
      updated_at: updatedAt,
    });
  });

  await Promise.all([submissionWrite, upsertResearcherFromSubmission(snapshot.payload, observedAt)]);
}

/**
 * Find the most-recently-observed in-progress (RESERVED/ACTIVE) submission, if
 * any was observed within `freshnessWindowMS`. Used so auto-open doesn't steal
 * focus while the user is mid-submission (issue #21). Returns null when there is
 * no fresh in-progress submission — including a stale/abandoned reservation
 * whose last observation predates the window.
 */
export async function findInProgressSubmission(
  freshnessWindowMS: number,
  nowMS: number = Date.now(),
): Promise<SubmissionRecord | null> {
  const rows = await db.submissions.where('phase').equals('submitting').toArray();
  if (rows.length === 0) return null;

  const cutoff = nowMS - freshnessWindowMS;
  let best: SubmissionRecord | null = null;
  let bestFreshness = -Infinity;
  for (const row of rows) {
    // `observed_at` is when we last actually saw this submission. `updated_at` is
    // rewritten to "now" on every upsert, so it can't tell a fresh observation
    // from a stale one — fall back to it only if `observed_at` is unparseable.
    const observedMS = Date.parse(row.observed_at);
    const freshness = Number.isFinite(observedMS) ? observedMS : Date.parse(row.updated_at);
    if (!Number.isFinite(freshness) || freshness < cutoff) continue;
    if (freshness > bestFreshness) {
      bestFreshness = freshness;
      best = row;
    }
  }
  return best;
}

/**
 * Return every submitted submission for analytics. No limit; caller should
 * tolerate large arrays (thousands).
 */
export async function getSubmissionsForAnalytics(): Promise<SubmissionRecord[]> {
  return db.submissions.where('phase').equals('submitted').toArray();
}

export interface ImportSummary {
  added: number;
  skipped_existing: number;
  total: number;
}

// Prolific calls this `study_code` on live responses and "Completion Code" in
// the CSV export. Treated as the primary cross-source dedup key.
function extractSubmissionCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  const raw = p.completion_code ?? p.study_code;
  return typeof raw === 'string' ? raw.trim() : '';
}

// Fallback dedup key for submissions Prolific exports without a completion
// code (some RETURNED rows). Collisions require the same user starting two
// same-named studies with identical reward in the same second.
function submissionSignature(row: { study_name?: string; payload: unknown }): string | null {
  const carrier = { payload: row.payload };
  const reward = extractSubmissionReward(carrier);
  const started = extractStartedAt(carrier);
  const name = (row.study_name ?? '').trim().toLowerCase();
  if (!reward || !started || !name) return null;
  const second = Math.floor(started.getTime() / 1000);
  return `${name}|${second}|${reward.amount}|${reward.currency}`;
}

async function deleteCsvDupes(
  incoming: { study_name: string; payload: unknown },
  phase: 'submitting' | 'submitted',
): Promise<void> {
  const code = extractSubmissionCode(incoming.payload);
  if (code) await db.submissions.delete(`${CSV_SUBMISSION_ID_PREFIX}${code}`);
  if (phase !== 'submitted') return;
  const sig = submissionSignature(incoming);
  if (!sig) return;
  const csvRows = await db.submissions
    .where('submission_id')
    .startsWith(CSV_SUBMISSION_ID_PREFIX)
    .toArray();
  const dupeIds = csvRows
    .filter((row) => submissionSignature(row) === sig)
    .map((row) => row.submission_id);
  if (dupeIds.length > 0) await db.submissions.bulkDelete(dupeIds);
}

// Merge externally-sourced submission records (e.g. CSV import) into the DB.
// Dedups against existing rows by completion code, falling back to signature
// when a code isn't available. Never overwrites existing records.
export async function importSubmissions(records: SubmissionRecord[]): Promise<ImportSummary> {
  if (records.length === 0) return { added: 0, skipped_existing: 0, total: 0 };
  return db.transaction('rw', db.submissions, async () => {
    const existingRows = await db.submissions.toArray();
    const existingIds = new Set(existingRows.map((r) => r.submission_id));
    const existingCodes = new Set<string>();
    const existingSigs = new Set<string>();
    for (const row of existingRows) {
      const code = extractSubmissionCode(row.payload);
      if (code) existingCodes.add(code);
      const sig = submissionSignature(row);
      if (sig) existingSigs.add(sig);
    }

    const fresh: SubmissionRecord[] = [];
    const seenCodes = new Set<string>();
    const seenSigs = new Set<string>();
    for (const r of records) {
      if (existingIds.has(r.submission_id)) continue;
      const code = extractSubmissionCode(r.payload);
      if (code) {
        if (existingCodes.has(code) || seenCodes.has(code)) continue;
        seenCodes.add(code);
      } else {
        const sig = submissionSignature(r);
        if (sig) {
          if (existingSigs.has(sig) || seenSigs.has(sig)) continue;
          seenSigs.add(sig);
        }
      }
      fresh.push(r);
    }

    if (fresh.length > 0) await db.submissions.bulkAdd(fresh);
    return {
      added: fresh.length,
      skipped_existing: records.length - fresh.length,
      total: records.length,
    };
  });
}

/**
 * Get current submissions, optionally filtered by phase.
 * Port of SubmissionsStore.GetCurrentSubmissions from stores.go:258-330.
 */
export async function getCurrentSubmissions(limit: number, phase: 'all' | 'submitting' | 'submitted'): Promise<Submission[]> {
  limit = clamp(limit, 200, 2000);

  let records: SubmissionRecord[];

  if (phase === 'all') {
    records = await db.submissions.toArray();
  } else {
    records = await db.submissions
      .where('phase')
      .equals(phase)
      .toArray();
  }

  records.sort((a, b) => {
    const cmp = b.observed_at.localeCompare(a.observed_at);
    if (cmp !== 0) return cmp;
    return b.submission_id.localeCompare(a.submission_id);
  });

  records = records.slice(0, limit);

  return records.map((r) => ({
    submission_id: r.submission_id,
    study_id: r.study_id,
    study_name: r.study_name,
    participant_id: r.participant_id || undefined,
    status: r.status,
    phase: r.phase,
    observed_at: r.observed_at,
    updated_at: r.updated_at,
    payload: r.payload,
  }));
}

// --- Helpers ---

function clamp(value: number, fallback: number, max: number): number {
  if (value <= 0) return fallback;
  if (value > max) return max;
  return value;
}
