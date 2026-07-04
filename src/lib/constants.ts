export const PROLIFIC_PATTERNS = ['*://app.prolific.com/*', '*://auth.prolific.com/*'];
export const STUDIES_REQUEST_PATTERN = '*://internal-api.prolific.com/api/v1/participant/studies/*';
export const PARTICIPANT_SUBMISSIONS_PATTERN = '*://internal-api.prolific.com/api/v1/participant/submissions/*';
const SUBMISSIONS_RESERVE_PATTERN = '*://internal-api.prolific.com/api/v1/submissions/reserve/*';
const SUBMISSIONS_TRANSITION_PATTERN = '*://internal-api.prolific.com/api/v1/submissions/*/transition/*';
export const SUBMISSION_PATTERNS = [SUBMISSIONS_RESERVE_PATTERN, SUBMISSIONS_TRANSITION_PATTERN];
export const OAUTH_TOKEN_PATTERN = '*://auth.prolific.com/oauth/token*';
export const PROLIFIC_STUDIES_URL = 'https://app.prolific.com/studies';
export const STUDIES_COLLECTION_PATH = '/api/v1/participant/studies/';
export const FETCH_STUDIES_API_URL = 'https://internal-api.prolific.com/api/v1/participant/studies/?sortBy=published_at&orderBy=asc';

export const DASHBOARD_DEFAULT_STUDIES_LIMIT = 50;
export const DASHBOARD_DEFAULT_EVENTS_LIMIT = 25;
export const DASHBOARD_DEFAULT_SUBMISSIONS_LIMIT = 100;

export const STATE_KEY = 'syncState';
export const PRIORITY_KNOWN_STUDIES_STATE_KEY = 'priorityKnownStudiesState';
export const AUTO_OPEN_PROLIFIC_TAB_KEY = 'autoOpenProlificTab';
export const PRIORITY_FILTERS_KEY = 'priorityFilters';
export const TELEGRAM_SETTINGS_KEY = 'telegramSettings';
export const MAX_PRIORITY_FILTERS = 10;

// Legacy keys — used only for one-time migration to PRIORITY_FILTERS_KEY
export const LEGACY_PRIORITY_FILTER_ENABLED_KEY = 'priorityFilterEnabled';
export const LEGACY_PRIORITY_FILTER_AUTO_OPEN_NEW_TAB_KEY = 'priorityFilterAutoOpenInNewTab';
export const LEGACY_PRIORITY_FILTER_ALERT_SOUND_ENABLED_KEY = 'priorityFilterAlertSoundEnabled';
export const LEGACY_PRIORITY_FILTER_ALERT_SOUND_TYPE_KEY = 'priorityFilterAlertSoundType';
export const LEGACY_PRIORITY_FILTER_ALERT_SOUND_VOLUME_KEY = 'priorityFilterAlertSoundVolume';
export const LEGACY_PRIORITY_FILTER_MIN_REWARD_KEY = 'priorityFilterMinimumReward';
export const LEGACY_PRIORITY_FILTER_MIN_HOURLY_REWARD_KEY = 'priorityFilterMinimumHourlyReward';
export const LEGACY_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES_KEY = 'priorityFilterMaximumEstimatedMinutes';
export const LEGACY_PRIORITY_FILTER_MIN_PLACES_KEY = 'priorityFilterMinimumPlaces';
export const LEGACY_PRIORITY_FILTER_ALWAYS_OPEN_KEYWORDS_KEY = 'priorityFilterKeywords';
export const LEGACY_PRIORITY_FILTER_IGNORE_KEYWORDS_KEY = 'priorityFilterIgnoreKeywords';
export const STUDIES_REFRESH_MIN_DELAY_SECONDS_KEY = 'studiesRefreshMinDelaySeconds';
export const STUDIES_REFRESH_AVERAGE_DELAY_SECONDS_KEY = 'studiesRefreshAverageDelaySeconds';
export const STUDIES_REFRESH_SPREAD_SECONDS_KEY = 'studiesRefreshSpreadSeconds';

export const STUDIES_REFRESH_CYCLE_SECONDS = 120;
export const DEFAULT_STUDIES_REFRESH_MIN_DELAY_SECONDS = 20;
export const DEFAULT_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS = 30;
export const DEFAULT_STUDIES_REFRESH_SPREAD_SECONDS = 0;
export const MIN_STUDIES_REFRESH_MIN_DELAY_SECONDS = 5;
export const MIN_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS = 25;
export const MAX_STUDIES_REFRESH_MIN_DELAY_SECONDS = 60;
export const MAX_STUDIES_REFRESH_AVERAGE_DELAY_SECONDS = 60;
export const MAX_STUDIES_REFRESH_SPREAD_SECONDS = 60;

export const DEFAULT_PRIORITY_FILTER_MIN_REWARD = 0;
export const DEFAULT_PRIORITY_FILTER_MIN_HOURLY_REWARD = 10;
export const DEFAULT_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES = 20;
export const DEFAULT_PRIORITY_FILTER_MIN_PLACES = 1;
export const MIN_PRIORITY_FILTER_MIN_REWARD = 0;
export const MAX_PRIORITY_FILTER_MIN_REWARD = 100;
export const MIN_PRIORITY_FILTER_MIN_HOURLY_REWARD = 0;
export const MAX_PRIORITY_FILTER_MIN_HOURLY_REWARD = 100;
export const MIN_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES = 1;
export const MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES = 240;
export const MIN_PRIORITY_FILTER_MIN_PLACES = 1;
export const MAX_PRIORITY_FILTER_MIN_PLACES = 1000;
export const MAX_PRIORITY_FILTER_KEYWORDS = 20;
export const MAX_PRIORITY_FILTER_RESEARCHERS = 50;
export const MAX_PRIORITY_STUDY_AUTO_OPEN_PER_BATCH = 3;

export const PRIORITY_KNOWN_STUDIES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MAX_PRIORITY_KNOWN_STUDIES = 3000;
export const PRIORITY_ACTION_SEEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_PRIORITY_ACTION_SEEN_STUDIES = 1000;
export const PRIORITY_ALERT_COOLDOWN_MS = 7000;
export const TELEGRAM_NOTIFY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export const SOUND_TYPE_NONE = 'none';
export const DEFAULT_PRIORITY_ALERT_SOUND_TYPE = 'pay';
export const DEFAULT_PRIORITY_ALERT_SOUND_VOLUME = 100;
export const MIN_PRIORITY_ALERT_SOUND_VOLUME = 0;
export const MAX_PRIORITY_ALERT_SOUND_VOLUME = 100;

export const DEFAULT_QUIET_HOURS_START = '23:00';
export const DEFAULT_QUIET_HOURS_END = '07:00';

export const PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH = Object.freeze({
  pay: '/sounds/pay.base64',
  metal_gear: '/sounds/metal_gear.base64',
  twitch: '/sounds/twitch.base64',
  chime: '/sounds/chime.base64',
  money: '/sounds/money.base64',
  samsung: '/sounds/samsung.base64',
  lbp: '/sounds/lbp.base64',
  taco: '/sounds/taco.base64',
} as const);

export type SoundType = keyof typeof PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH;
export const PRIORITY_ALERT_SOUND_TYPES = new Set<SoundType>(
  Object.keys(PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH) as SoundType[],
);

export const DEBUG_LOG_LIMIT = 200;
export const DEBUG_LOG_SUPPRESSED_EVENTS = new Set([
  'alarm.scheduled',
  'alarm.fired',
  'token.sync.start',
  'token.sync.skip_in_progress',
  'tab.updated.prolific',
  'tab.removed',
  'studies.request.completed',
  'studies.request.completed.skip_non_collection',
  'studies.response.capture.before_request',
  'studies.response.capture.before_request.skip_non_collection',
  'studies.response.capture.stop',
  'studies.response.capture.skip_non_collection',
]);

export const AUTH_REQUIRED_MESSAGE = 'Signed out of Prolific. Log in at app.prolific.com to resume syncing.';
export const AUTH_REQUIRED_PANEL_MESSAGE = 'Waiting for login.';

export const TELEGRAM_API_BASE_URL = 'https://api.telegram.org/bot';
export const TELEGRAM_SETTINGS_PERSIST_DEBOUNCE_MS = 400;
export const TELEGRAM_VERIFY_DEBOUNCE_MS = 800;

export const DEFAULT_TELEGRAM_SETTINGS = Object.freeze({
  enabled: false,
  bot_token: '',
  chat_id: '',
  notify_all_studies: false,
  silent_notifications: false,
  message_format: Object.freeze({
    include_reward: true,
    include_hourly_rate: true,
    include_duration: true,
    include_places: true,
    include_researcher: true,
    include_tags: true,
    include_description: false,
    include_link: true,
  }),
});

export const DEFAULT_REFRESH_INTERVAL_MS = 60_000;
export const REACTIVE_REFRESH_DEBOUNCE_MS = 150;
export const PRIORITY_FILTER_PERSIST_DEBOUNCE_MS = 250;

// ─── Study-history insights ──────────────────────────────────
/**
 * Max gap (ms) between observations for a study's lifecycle to count as "continuously watched". Event
 * timestamps are only trustworthy when Pulse was actually observing across them: if a study's last
 * seen-present observation is more than this before its `unavailable` event (or nothing was observed
 * this long before it appeared), it changed while we weren't watching, so its fill time / "drop" time
 * is noise and must be excluded. Comfortably above the normal refresh cadence (≤ ~2 min) so continuous
 * use is never penalised, but far below real session gaps (hours/days).
 */
export const RELIABLE_OBSERVATION_GAP_MS = 15 * 60 * 1000; // 15 minutes
/** Hard cap on rows loaded for the Insights view (most-recent first). Compaction keeps this ample. */
export const INSIGHTS_MAX_HISTORY_ROWS = 20_000;
export const INSIGHTS_MAX_EVENTS = 5_000;
/** Most-recent observation-log heartbeats loaded to reconstruct the "were we watching" timeline. */
export const INSIGHTS_MAX_OBSERVATIONS = 30_000;
/**
 * Minimum spacing between recorded heartbeats — refreshes closer than this are not logged. Comfortably
 * below RELIABLE_OBSERVATION_GAP_MS (so continuous watching still leaves a heartbeat within the trust
 * window before any drop), but coarse enough that INSIGHTS_MAX_OBSERVATIONS covers months of active use
 * rather than ~a week, and the ingest path writes far fewer rows.
 */
export const OBSERVATION_MIN_SPACING_MS = 5 * 60 * 1000; // 5 minutes
/** How many price moves / reruns / fastest fillers the Insights panel shows per section. */
export const INSIGHTS_SECTION_LIMIT = 6;
/**
 * Retention: studiesHistory records a full snapshot every refresh, so it grows without bound. We
 * compact it by dropping strictly-redundant consecutive snapshots (see redundantHistoryRowIds) and,
 * as a far backstop, drop anything older than the retention window.
 */
export const STUDY_HISTORY_RETENTION_DAYS = 120;
/**
 * How often the background history-compaction alarm fires. Hourly keeps the raw (un-compacted) table
 * well under INSIGHTS_MAX_HISTORY_ROWS between passes even for a busy feed, so the Insights read never
 * evicts a study's baseline snapshot. The pass itself is cheap (a bounded scan + bulk delete).
 */
export const STUDY_HISTORY_PRUNE_PERIOD_MINUTES = 60;

// ─── Backend resilience (issue #25) ──────────────────────────
/**
 * Fraction of the storage quota at which we start proactively compacting (`warn`) and at which we
 * emergency-prune to a hard row cap (`critical`) — before writes begin failing. IndexedDB quotas are
 * large (often GBs), so these leave ample headroom while still acting well ahead of a hard wall.
 */
export const STORAGE_PRESSURE_WARN_RATIO = 0.75;
export const STORAGE_PRESSURE_CRITICAL_RATIO = 0.9;
/** How often the background storage-quota watchdog runs. Independent of the hourly compaction alarm. */
export const STORAGE_QUOTA_CHECK_PERIOD_MINUTES = 30;
/**
 * Under `critical` pressure we drop the raw studiesHistory table down to this many most-recent rows —
 * a last-resort backstop that trades Insights depth for not bricking the extension on a full disk.
 * Kept below INSIGHTS_MAX_HISTORY_ROWS so it only ever bites in a genuine emergency.
 */
export const STUDY_HISTORY_CRITICAL_ROW_CAP = 8_000;
/**
 * Consecutive failed studies refreshes before the popup surfaces a persistent "it stopped updating"
 * recovery state (rather than treating every blip as an outage). Low enough to notice a real stall
 * within a refresh cycle or two.
 */
export const REFRESH_PERSISTENT_FAILURE_THRESHOLD = 3;
/**
 * Auth-recovery escalation bands, keyed on consecutive 401s: ≤ RESYNC_MAX just re-reads the token,
 * ≤ RELOAD_MAX reloads the Prolific tab to force a silent renew, and beyond that we stop and ask the
 * user to log in — so a genuinely dead token never spins the recovery loop forever.
 */
export const AUTH_EXPIRY_RESYNC_MAX_ATTEMPTS = 2;
export const AUTH_EXPIRY_RELOAD_MAX_ATTEMPTS = 4;
/** Human-readable recovery lines the popup StatusBar renders (display side proper is #24). */
export const REFRESH_RECONNECTING_MESSAGE = 'Prolific session expired — reconnecting…';
export const REFRESH_PERSISTENT_FAILURE_MESSAGE =
  "Studies aren't updating. Check your connection, or reload the Prolific tab.";

// ─── Earnings analytics ──────────────────────────────────────
export const EARNINGS_PREFS_KEY = 'earningsPrefs';
export const DEFAULT_EARNINGS_INCLUDE_PENDING = true;
/**
 * Common currencies always shown in the settings picker so users can
 * configure FX pre-emptively (before Prolific gives them rewards in one).
 */
export const SEED_CURRENCIES = Object.freeze(['USD', 'GBP', 'EUR', 'CAD', 'AUD']) as readonly string[];
