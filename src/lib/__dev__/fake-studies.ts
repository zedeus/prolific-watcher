import type { Study, Money } from '../types';
import type { StudyLatestRecord, StudyActiveSnapshotRecord, ResearcherRecord, StudyAvailabilityEventRecord, StudyHistoryRecord } from '../db';
import { db } from '../db';
import { makeRng, pick } from './rng';
import { STATE_KEY } from '../constants';

function gaussian(rng: () => number, mean: number, sd: number): number {
  const u1 = Math.max(1e-9, rng());
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + sd * z;
}

const STUDY_TEMPLATES: readonly {
  name: string;
  meanMinutes: number;
  sdMinutes: number;
  meanRewardGBP: number;
  sdRewardGBP: number;
  labels: string[];
}[] = [
  { name: 'Quick opinion survey on daily habits', meanMinutes: 3, sdMinutes: 1, meanRewardGBP: 0.50, sdRewardGBP: 0.15, labels: ['survey'] },
  { name: 'LLM output rating — coding questions', meanMinutes: 30, sdMinutes: 10, meanRewardGBP: 6.00, sdRewardGBP: 1.20, labels: ['ai', 'coding'] },
  { name: 'Visual attention task', meanMinutes: 15, sdMinutes: 4, meanRewardGBP: 3.00, sdRewardGBP: 0.80, labels: ['experiment'] },
  { name: 'Political attitudes questionnaire', meanMinutes: 20, sdMinutes: 5, meanRewardGBP: 4.00, sdRewardGBP: 0.90, labels: ['survey', 'politics'] },
  { name: 'Moral dilemma decision-making', meanMinutes: 10, sdMinutes: 3, meanRewardGBP: 2.00, sdRewardGBP: 0.40, labels: ['psychology'] },
  { name: 'Memory recall study', meanMinutes: 25, sdMinutes: 7, meanRewardGBP: 5.00, sdRewardGBP: 1.00, labels: ['experiment'] },
  { name: 'Product feedback — fintech prototype', meanMinutes: 40, sdMinutes: 12, meanRewardGBP: 9.00, sdRewardGBP: 1.80, labels: ['usability'] },
  { name: 'Image matching and categorisation', meanMinutes: 10, sdMinutes: 2, meanRewardGBP: 2.50, sdRewardGBP: 0.40, labels: ['experiment'] },
  { name: 'Personality inventory (short form)', meanMinutes: 8, sdMinutes: 1.5, meanRewardGBP: 1.80, sdRewardGBP: 0.30, labels: ['survey', 'psychology'] },
  { name: 'Sleep and wellbeing longitudinal — week 3', meanMinutes: 12, sdMinutes: 3, meanRewardGBP: 3.50, sdRewardGBP: 0.50, labels: ['longitudinal'] },
  { name: 'Advertising effectiveness — video', meanMinutes: 15, sdMinutes: 4, meanRewardGBP: 3.25, sdRewardGBP: 0.60, labels: ['marketing'] },
  { name: 'Reaction time experiment', meanMinutes: 7, sdMinutes: 1.5, meanRewardGBP: 1.80, sdRewardGBP: 0.30, labels: ['experiment'] },
  { name: 'Consumer preferences — luxury goods', meanMinutes: 18, sdMinutes: 4, meanRewardGBP: 4.50, sdRewardGBP: 0.90, labels: ['marketing', 'survey'] },
  { name: 'Language comprehension task', meanMinutes: 22, sdMinutes: 5, meanRewardGBP: 5.50, sdRewardGBP: 1.10, labels: ['linguistics'] },
  { name: 'Social media usage patterns', meanMinutes: 12, sdMinutes: 3, meanRewardGBP: 3.00, sdRewardGBP: 0.60, labels: ['survey'] },
];

const RESEARCHERS: readonly { id: string; name: string; country: string }[] = [
  { id: 'r-001', name: 'Oxford Behavioural Lab', country: 'United Kingdom' },
  { id: 'r-002', name: 'Prolific Research Team', country: 'United Kingdom' },
  { id: 'r-003', name: 'Anthropic Evaluations', country: 'United States' },
  { id: 'r-004', name: 'MIT Media Lab', country: 'United States' },
  { id: 'r-005', name: "King's College Psych", country: 'United Kingdom' },
  { id: 'r-006', name: 'Acme Usability Studio', country: 'Germany' },
  { id: 'r-007', name: 'Stanford NLP Group', country: 'United States' },
  { id: 'r-008', name: 'Dr A. Singh (UCL)', country: 'United Kingdom' },
  { id: 'r-009', name: 'Very Long Researcher Name That Should Truncate Properly', country: 'Australia' },
];

function makeMoney(amountMajor: number, currency = 'GBP'): Money {
  return { amount: Math.round(amountMajor * 100), currency };
}

function generateStudy(rng: () => number, index: number, publishedAt: Date): Study {
  const template = pick(STUDY_TEMPLATES, rng);
  const researcher = pick(RESEARCHERS, rng);

  const durationMinutes = Math.max(1, Math.round(gaussian(rng, template.meanMinutes, template.sdMinutes)));
  const rewardMajor = Math.max(0.10, gaussian(rng, template.meanRewardGBP, template.sdRewardGBP));
  const hourlyMajor = (rewardMajor / durationMinutes) * 60;

  const totalPlaces = Math.max(1, Math.round(gaussian(rng, 50, 30)));
  const placesTaken = Math.floor(rng() * totalPlaces * 0.7);
  const placesAvailable = totalPlaces - placesTaken;

  const studyId = `study-fake-${String(index).padStart(6, '0')}`;

  return {
    id: studyId,
    name: template.name,
    study_type: 'single',
    date_created: publishedAt.toISOString(),
    published_at: publishedAt.toISOString(),
    total_available_places: totalPlaces,
    places_taken: placesTaken,
    places_available: placesAvailable,
    reward: makeMoney(rewardMajor),
    average_reward_per_hour: makeMoney(hourlyMajor),
    max_submissions_per_participant: 1,
    researcher: {
      id: researcher.id,
      name: researcher.name,
      country: researcher.country,
    },
    description: `This is a study about ${template.name.toLowerCase()}. Participants will complete tasks related to the topic.`,
    estimated_completion_time: durationMinutes,
    device_compatibility: ['desktop', 'mobile', 'tablet'],
    peripheral_requirements: [],
    maximum_allowed_time: durationMinutes * 3,
    average_completion_time_in_seconds: durationMinutes * 60,
    is_confidential: false,
    is_ongoing_study: false,
    pii_enabled: false,
    is_custom_screening: false,
    study_labels: template.labels,
    ai_inferred_study_labels: [],
    previous_submission_count: 0,
    first_seen_at: publishedAt.toISOString(),
  };
}

export interface FakeStudiesOptions {
  count: number;
  seed?: number;
  now?: Date;
}

function generateFakeStudies(options: FakeStudiesOptions): Study[] {
  const { count, seed = 42, now = new Date() } = options;
  const rng = makeRng(seed);
  const studies: Study[] = [];

  for (let i = 0; i < count; i++) {
    const hoursAgo = rng() * 24;
    const publishedAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
    studies.push(generateStudy(rng, i, publishedAt));
  }

  return studies;
}

// Mirror real ingest: production populates `researchers` (upsertResearchersFromStudies) and
// availability events (reconcileAvailability) as studies flow in, but the dev seeder used to skip
// both — leaving the researcher picker and reliability profiles empty. Derive them from the seeded
// studies so the researcher-reliability surfaces have data to render.
function buildResearcherRecords(now: Date): ResearcherRecord[] {
  const nowIso = now.toISOString();
  return RESEARCHERS.map((r, i) => ({
    id: r.id,
    name: r.name,
    country: r.country,
    // Spread "first seen" across the past few months so profiles show varied tenure.
    first_seen_at: new Date(now.getTime() - (30 + i * 21) * 86_400_000).toISOString(),
    last_seen_at: nowIso,
    study_count: 0,
    submission_count: 0,
  }));
}

// Days of study-history/event timeline to fabricate behind "now".
const HISTORY_WINDOW_DAYS = 8;
const SNAPSHOT_INTERVAL_MS = 3 * 60 * 60 * 1000; // mirror ~a refresh cadence, collapsed
// Posting cadence peaks in the daytime so the Insights "best times" chart shows a clear shape.
const HOUR_WEIGHTS = [
  0.3, 0.2, 0.15, 0.15, 0.2, 0.4, 0.8, 1.6, 2.6, 3.4, 4.0, 3.8, // 0..11
  3.4, 3.6, 3.9, 3.7, 3.0, 2.4, 2.0, 1.7, 1.4, 1.1, 0.8, 0.5, // 12..23
];

function pickHour(rng: () => number): number {
  const total = HOUR_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let h = 0; h < 24; h++) {
    r -= HOUR_WEIGHTS[h];
    if (r <= 0) return h;
  }
  return 12;
}

/** A past instant at a given local hour, N days ago — local constructor keeps the hour TZ-stable. */
function pastLocal(now: Date, daysAgo: number, hour: number, rng: () => number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, Math.floor(rng() * 60), 0, 0);
}

/** A study snapshot payload with a given reward + remaining places (mirrors the real history shape). */
function snapshotPayload(study: Study, rewardMinor: number, placesAvailable: number): Record<string, unknown> {
  const durationMin = Number(study.estimated_completion_time) || 10;
  const hourly = Math.round((rewardMinor / durationMin) * 60);
  return {
    ...study,
    reward: { amount: rewardMinor, currency: study.reward.currency },
    average_reward_per_hour: { amount: hourly, currency: study.reward.currency },
    places_available: placesAvailable,
  };
}

interface Cycle {
  start: Date;
  end: Date | null; // null = still listed
}

interface StudyActivity {
  events: Omit<StudyAvailabilityEventRecord, 'row_id'>[];
  history: Omit<StudyHistoryRecord, 'row_id'>[];
}

/**
 * Fabricate a study-history + availability-event timeline rich enough to exercise every Insights
 * analysis: fill speed (closed listings), posting cadence (daytime-biased `available` times), price
 * moves (reward bumps/cuts on long-lived studies), and reruns (studies re-listed on a schedule).
 * Deterministic given the seed.
 */
function buildStudyActivity(studies: Study[], now: Date, seed: number): StudyActivity {
  const rng = makeRng(seed + 7);
  const events: Omit<StudyAvailabilityEventRecord, 'row_id'>[] = [];
  const history: Omit<StudyHistoryRecord, 'row_id'>[] = [];

  for (let idx = 0; idx < studies.length; idx++) {
    const s = studies[idx];
    const baseReward = s.reward.amount;
    const totalPlaces = s.total_available_places || 50;

    const cycles: Cycle[] = [];
    let changeAtMs = Infinity;
    let bumpedReward = baseReward;

    if (idx % 5 === 0) {
      // Regular rerun: 3–4 near-daily listings at a stable local hour → flagged "scheduled".
      // Anchor reruns in the working day (9am–4pm) so their concentrated postings reinforce — rather
      // than fight — the daytime posting-cadence peak in the seeded demo.
      const count = 3 + Math.floor(rng() * 2);
      const hour = 9 + Math.floor(rng() * 8);
      for (let c = count - 1; c >= 0; c--) {
        const start = pastLocal(now, c, hour, rng);
        const listedMin = 25 + Math.floor(rng() * 90);
        const stillLive = c === 0 && rng() < 0.4;
        cycles.push({ start, end: stillLive ? null : new Date(start.getTime() + listedMin * 60_000) });
      }
    } else if (idx % 5 === 1) {
      // Long-lived (listed 6–8 days ago, still listed), with one reward change partway → a price move.
      // Anchored to a daytime hour (like reruns/normal) so the posting-cadence peak is daytime and
      // timezone-independent, instead of drifting with the absolute seed time.
      const start = pastLocal(now, 6 + Math.floor(rng() * 2), pickHour(rng), rng);
      cycles.push({ start, end: null });
      const dir = rng() < 0.6 ? 1 : -1;
      const frac = 0.15 + rng() * 0.3;
      bumpedReward = Math.max(50, Math.round(baseReward * (1 + dir * frac)));
      changeAtMs = start.getTime() + (0.4 + rng() * 0.2) * (now.getTime() - start.getTime());
    } else {
      // Normal single listing somewhere in the window; some fill fast, ~40% still live.
      const daysAgo = Math.floor(rng() * HISTORY_WINDOW_DAYS);
      const start = pastLocal(now, daysAgo, pickHour(rng), rng);
      const fast = idx % 7 === 3;
      const listedMin = fast ? 3 + Math.floor(rng() * 12) : 25 + Math.floor(rng() * 150);
      const stillLive = daysAgo === 0 && rng() < 0.4;
      cycles.push({ start, end: stillLive ? null : new Date(start.getTime() + listedMin * 60_000) });
    }

    for (const cy of cycles) {
      events.push({ study_id: s.id, study_name: s.name, event_type: 'available', observed_at: cy.start.toISOString() });
      const end = cy.end ? cy.end.getTime() : now.getTime();
      let placesLeft = totalPlaces;
      for (let t = cy.start.getTime(); t <= end; t += SNAPSHOT_INTERVAL_MS) {
        const rewardAt = t >= changeAtMs ? bumpedReward : baseReward;
        placesLeft = Math.max(0, placesLeft - Math.round(rng() * 2));
        history.push({ study_id: s.id, observed_at: new Date(t).toISOString(), payload: snapshotPayload(s, rewardAt, placesLeft) });
      }
      if (cy.end) {
        events.push({ study_id: s.id, study_name: s.name, event_type: 'unavailable', observed_at: cy.end.toISOString() });
      }
    }
  }

  return { events, history };
}

export async function seedFakeStudies(count: number, seed = 42): Promise<number> {
  const studies = generateFakeStudies({ count, seed });
  const nowDate = new Date();
  const now = nowDate.toISOString();

  const latestRecords: StudyLatestRecord[] = studies.map((s) => ({
    study_id: s.id,
    name: s.name,
    payload: s as unknown as Record<string, unknown>,
    last_seen_at: now,
  }));

  const snapshotRecords: StudyActiveSnapshotRecord[] = studies.map((s) => ({
    study_id: s.id,
    name: s.name,
    first_seen_at: s.first_seen_at || now,
    last_seen_at: now,
  }));

  const activity = buildStudyActivity(studies, nowDate, seed);

  await db.transaction(
    'rw',
    [db.studiesLatest, db.studiesActiveSnapshot, db.serviceState, db.researchers, db.studyAvailabilityEvents, db.studiesHistory],
    async () => {
      await db.studiesLatest.bulkPut(latestRecords);
      await db.studiesActiveSnapshot.bulkPut(snapshotRecords);
      await db.researchers.bulkPut(buildResearcherRecords(nowDate));
      await db.studyAvailabilityEvents.bulkAdd(activity.events);
      await db.studiesHistory.bulkAdd(activity.history);
      // Seed service state so the popup shows as "logged in"
      await db.serviceState.put({
        id: 1,
        last_studies_refresh_at: now,
        last_studies_refresh_source: 'fake-studies',
        updated_at: now,
      });
    },
  );

  // Also seed the sync state in browser storage so auth check passes
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = typeof browser !== 'undefined' ? browser : (typeof (globalThis as any).chrome !== 'undefined' ? (globalThis as any).chrome : null);
  const storage = b && (b as { storage?: { local?: { set: (items: Record<string, unknown>) => Promise<void> } } }).storage?.local;
  if (storage) {
    await storage.set({ [STATE_KEY]: { token_ok: true, token_auth_required: false } });
  }

  return studies.length;
}

/**
 * Dev/test isolation only: wipe ALL study tables (not just the seeded fake rows). The visual specs
 * share the persistent Prolific login profile, whose IndexedDB can hold real availability events
 * captured by the e2e specs — those would otherwise leak into the seeded Insights demo. Never wired
 * into production UI.
 */
export async function wipeStudyData(): Promise<void> {
  await db.transaction(
    'rw',
    [db.studiesLatest, db.studiesActiveSnapshot, db.studyAvailabilityEvents, db.studiesHistory],
    async () => {
      await db.studiesLatest.clear();
      await db.studiesActiveSnapshot.clear();
      await db.studyAvailabilityEvents.clear();
      await db.studiesHistory.clear();
    },
  );
}

export async function clearFakeStudies(): Promise<void> {
  await db.transaction(
    'rw',
    [db.studiesLatest, db.studiesActiveSnapshot, db.serviceState, db.researchers, db.studyAvailabilityEvents, db.studiesHistory],
    async () => {
      await db.studiesLatest.where('study_id').startsWith('study-fake-').delete();
      await db.studiesActiveSnapshot.where('study_id').startsWith('study-fake-').delete();
      await db.studyAvailabilityEvents.where('study_id').startsWith('study-fake-').delete();
      await db.studiesHistory.where('study_id').startsWith('study-fake-').delete();
      await db.researchers.bulkDelete(RESEARCHERS.map((r) => r.id));
      // Clear service state to reset to "logged out"
      await db.serviceState.delete(1);
    },
  );

  // Clear sync state in browser storage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = typeof browser !== 'undefined' ? browser : (typeof (globalThis as any).chrome !== 'undefined' ? (globalThis as any).chrome : null);
  const storage = b && (b as { storage?: { local?: { remove: (keys: string[]) => Promise<void> } } }).storage?.local;
  if (storage) {
    await storage.remove([STATE_KEY]);
  }
}
