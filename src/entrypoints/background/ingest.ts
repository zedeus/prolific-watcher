import {
  normalizeStudiesResponse,
  normalizeSubmissionSnapshot,
} from '../../lib/normalize';
import * as store from '../../lib/store';
import type { AvailabilitySummary } from '../../lib/store';

/**
 * Ingest an intercepted studies API response.
 * Normalizes, stores, reconciles availability, and updates refresh state.
 * Returns the availability summary for priority processing.
 */
export async function ingestStudiesResponse(
  body: unknown,
  observedAt: string,
  source: string,
  url: string,
  statusCode: number,
): Promise<AvailabilitySummary | null> {
  if (!statusCode) statusCode = 200;

  let studies;
  try {
    studies = normalizeStudiesResponse(body);
  } catch (error) {
    // Still record the refresh attempt even on parse failure
    await store.setStudiesRefresh({
      observed_at: observedAt,
      source,
      url,
      status_code: statusCode,
    });
    throw error;
  }

  // These touch disjoint tables so can run in parallel. recordObservation logs a durable "we were
  // watching now" heartbeat — even for an empty feed, which writes no study history — so the insights
  // reliability check can tell "watching, nothing there" from "not watching".
  const [, availability] = await Promise.all([
    store.storeNormalizedStudies(studies, observedAt),
    store.reconcileAvailability(studies, observedAt),
    store.setStudiesRefresh({ observed_at: observedAt, source, url, status_code: statusCode }),
    store.recordObservation(observedAt),
  ]);

  return availability;
}

/**
 * Ingest a single submission reserve/transition response.
 */
export async function ingestSubmissionResponse(body: unknown, observedAt: string): Promise<void> {
  const snapshot = normalizeSubmissionSnapshot(body);
  await store.upsertSubmission(snapshot, observedAt);
}

/**
 * Ingest a participant submissions list response.
 */
export async function ingestParticipantSubmissionsResponse(body: unknown, observedAt: string): Promise<void> {
  if (!body || typeof body !== 'object') return;
  const envelope = body as Record<string, unknown>;
  const results = Array.isArray(envelope.results) ? envelope.results : [];

  for (const item of results) {
    try {
      const snapshot = normalizeSubmissionSnapshot(item);
      await store.upsertSubmission(snapshot, observedAt);
    } catch {
      // Skip malformed items, matching Go behavior
    }
  }
}
