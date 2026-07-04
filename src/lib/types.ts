export interface Money {
  amount: number;
  currency: string;
}

export interface Researcher {
  id: string;
  name: string;
  country: string;
}

export interface Study {
  id: string;
  name: string;
  study_type: string;
  date_created: string;
  published_at: string;
  total_available_places: number;
  places_taken: number;
  places_available: number;
  reward: Money;
  average_reward_per_hour: Money;
  max_submissions_per_participant: number;
  researcher: Researcher;
  description: string;
  estimated_completion_time: number;
  device_compatibility: string[];
  peripheral_requirements: string[];
  maximum_allowed_time: number;
  average_completion_time_in_seconds: number;
  is_confidential: boolean;
  is_ongoing_study: boolean;
  submission_started_at?: string | null;
  pii_enabled: boolean;
  is_custom_screening: boolean;
  study_labels: string[];
  ai_inferred_study_labels: string[];
  previous_submission_count: number;
  first_seen_at?: string;
}

export interface StudyEvent {
  row_id: number;
  study_id: string;
  study_name: string;
  event_type: 'available' | 'unavailable';
  observed_at: string;
  reward: Money;
  average_reward_per_hour: Money;
  estimated_completion_time: number;
  total_available_places: number;
  places_available: number;
  researcher_name: string;
  researcher_id: string;
}

export interface Submission {
  submission_id: string;
  study_id: string;
  study_name: string;
  participant_id?: string;
  status: string;
  phase: 'submitting' | 'submitted';
  observed_at: string;
  updated_at: string;
  payload?: unknown;
}

export interface StudiesRefreshState {
  last_studies_refresh_at?: string;
  last_studies_refresh_source?: string;
  last_studies_refresh_url?: string;
  last_studies_refresh_status?: number;
}

export interface ResearcherRef {
  id: string;
  name: string;
}

/** Which of a priority filter's list pairs (match/ignore) to target. Applies to both keyword and researcher lists. */
export type FilterListField = 'match' | 'ignore';

export interface PriorityFilter {
  id: string;
  name: string;
  enabled: boolean;
  auto_open_in_new_tab: boolean;
  alert_sound_enabled: boolean;
  alert_sound_type: string;
  alert_sound_volume: number;
  telegram_notify: boolean;
  desktop_notify: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: string;
  quiet_hours_end: string;
  minimum_reward_major: number;
  minimum_hourly_reward_major: number;
  maximum_estimated_minutes: number;
  minimum_places_available: number;
  match_keywords: string[];
  ignore_keywords: string[];
  match_researchers: ResearcherRef[];
  ignore_researchers: ResearcherRef[];
}

export interface TelegramMessageFormatOptions {
  include_reward: boolean;
  include_hourly_rate: boolean;
  include_duration: boolean;
  include_places: boolean;
  include_researcher: boolean;
  include_tags: boolean;
  include_description: boolean;
  include_link: boolean;
}

export interface TelegramSettings {
  enabled: boolean;
  bot_token: string;
  chat_id: string;
  notify_all_studies: boolean;
  silent_notifications: boolean;
  message_format: TelegramMessageFormatOptions;
}

export interface RefreshPolicy {
  minimum_delay_seconds: number;
  average_delay_seconds: number;
  spread_seconds: number;
}

export interface NormalizedRefreshPolicy extends RefreshPolicy {
  cycle_seconds: number;
  maximum_minimum_delay_seconds: number;
  maximum_spread_seconds: number;
}

export interface Settings {
  auto_open_prolific_tab: boolean;
  studies_refresh_min_delay_seconds: number;
  studies_refresh_average_delay_seconds: number;
  studies_refresh_spread_seconds: number;
}

export interface SyncState {
  // Token
  token_ok: boolean;
  token_auth_required: boolean;
  token_trigger: string;
  token_reason: string;
  token_key: string;
  token_origin: string;
  token_last_success_at: string;
  access_token: string;
  token_type: string;

  // Studies refresh
  studies_refresh_ok: boolean;
  studies_refresh_reason: string;
  studies_refresh_last_at: string;

  // Backend resilience (issue #25)
  studies_refresh_consecutive_failures: number;
  studies_refresh_last_outcome: string;
  studies_refresh_recovery_active: boolean;
  storage_bytes_used: number;
  storage_quota_bytes: number;
  storage_usage_ratio: number;
  storage_pressure: string;
  storage_checked_at: string;
  storage_last_prune_at: string;
  storage_last_prune_deleted: number;

  // Response capture
  studies_response_capture_ok: boolean;
  studies_response_capture_reason: string;
  studies_response_capture_last_at: string;
  studies_response_capture_supported: boolean;
  studies_response_capture_registered: boolean;
  studies_response_capture_checked_at: string;

  // OAuth capture
  oauth_response_capture_supported: boolean;
  oauth_response_capture_reason: string;
  oauth_response_capture_checked_at: string;

  // Counters
  token_sync_success_count: number;
  token_sync_error_count: number;
  oauth_token_capture_success_count: number;
  studies_request_completed_count: number;
  studies_response_before_request_count: number;
  studies_response_ingest_success_count: number;
  studies_response_ingest_error_count: number;
  studies_response_parse_error_count: number;
  studies_response_filter_error_count: number;
  submission_response_before_request_count: number;
  submission_response_ingest_success_count: number;
  submission_response_ingest_error_count: number;
  submission_response_parse_error_count: number;
  submission_response_filter_error_count: number;
  participant_submissions_response_before_request_count: number;
  participant_submissions_response_ingest_success_count: number;
  participant_submissions_response_ingest_error_count: number;
  participant_submissions_response_parse_error_count: number;
  participant_submissions_response_filter_error_count: number;
  priority_alert_sound_count: number;
  priority_study_auto_open_count: number;
  priority_telegram_notify_count: number;
  priority_desktop_notify_count: number;
  tab_auto_open_count: number;

  // Priority alerts
  priority_alert_last_at: string;
  priority_alert_last_trigger: string;
  priority_alert_last_study_count: number;
  priority_alert_sound_mode: string;

  // Telegram
  telegram_enabled: boolean;
  telegram_notify_last_at: string;
  telegram_notify_last_trigger: string;
  // Auto-open
  priority_study_auto_open_last_at: string;
  priority_study_auto_open_last_trigger: string;
  priority_study_auto_open_last_count: number;
  auto_open_enabled: boolean;
  auto_open_last_opened_at: string;

  // Refresh policy
  studies_refresh_min_delay_seconds: number;
  studies_refresh_average_delay_seconds: number;
  studies_refresh_spread_seconds: number;
  studies_refresh_cycle_seconds: number;

  // Priority filters
  priority_filters_count: number;
  priority_filters_enabled_count: number;

  // Debug
  debug_logs: DebugLogEntry[];
  debug_log_count_total: number;

  // Metadata
  updated_at: string;
}

export interface DebugLogEntry {
  at: string;
  event: string;
  details?: Record<string, unknown>;
  repeat_count?: number;
}





