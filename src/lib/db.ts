import Dexie, { type EntityTable } from 'dexie';

export interface StudyLatestRecord {
  study_id: string;
  name: string;
  payload: Record<string, unknown>;
  last_seen_at: string;
}

export interface StudyHistoryRecord {
  row_id?: number;
  study_id: string;
  observed_at: string;
  payload: Record<string, unknown>;
}

export interface StudyActiveSnapshotRecord {
  study_id: string;
  name: string;
  first_seen_at: string;
  last_seen_at: string;
}

export interface StudyAvailabilityEventRecord {
  row_id?: number;
  study_id: string;
  study_name: string;
  event_type: 'available' | 'unavailable';
  observed_at: string;
}

export interface ServiceStateRecord {
  id: number;
  last_studies_refresh_at?: string;
  last_studies_refresh_source?: string;
  last_studies_refresh_url?: string;
  last_studies_refresh_status?: number;
  updated_at: string;
}

export interface SubmissionRecord {
  submission_id: string;
  study_id: string;
  study_name: string;
  participant_id: string;
  status: string;
  phase: 'submitting' | 'submitted';
  payload: Record<string, unknown>;
  observed_at: string;
  updated_at: string;
}

export interface ResearcherRecord {
  id: string;
  name: string;
  country: string;
  first_seen_at: string;
  last_seen_at: string;
  study_count: number;
  submission_count: number;
}

/**
 * A durable "we were watching at this instant" heartbeat, written on studies refreshes (incl. empty
 * feeds) but downsampled to ~5-min spacing (see recordObservation). Unlike studiesHistory it is never
 * compacted (only aged out), so it's the trustworthy observation timeline the insights reliability
 * check reads (see study-history.ts).
 */
export interface ObservationLogRecord {
  id?: number;
  at: string;
}

class ProlificPulseDB extends Dexie {
  studiesLatest!: EntityTable<StudyLatestRecord, 'study_id'>;
  studiesHistory!: EntityTable<StudyHistoryRecord, 'row_id'>;
  studiesActiveSnapshot!: EntityTable<StudyActiveSnapshotRecord, 'study_id'>;
  studyAvailabilityEvents!: EntityTable<StudyAvailabilityEventRecord, 'row_id'>;
  serviceState!: EntityTable<ServiceStateRecord, 'id'>;
  submissions!: EntityTable<SubmissionRecord, 'submission_id'>;
  researchers!: EntityTable<ResearcherRecord, 'id'>;
  observationLog!: EntityTable<ObservationLogRecord, 'id'>;

  constructor() {
    super('prolific-pulse');
    this.version(1).stores({
      studiesLatest: 'study_id',
      studiesHistory: '++row_id, study_id, observed_at',
      studiesActiveSnapshot: 'study_id',
      studyAvailabilityEvents: '++row_id, study_id, observed_at',
      serviceState: 'id',
      submissions: 'submission_id, phase, observed_at',
    });
    this.version(2).stores({
      researchers: 'id, last_seen_at',
    });
    this.version(3).stores({
      observationLog: '++id, at',
    });
  }
}

export const db = new ProlificPulseDB();
