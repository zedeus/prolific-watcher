<script lang="ts">
  import { untrack } from 'svelte';
  import { browser } from 'wxt/browser';
  import type { Study, PriorityFilter, NormalizedRefreshPolicy, SyncState, StudiesRefreshState, DebugLogEntry, TelegramSettings, ResearcherRef, FilterListField } from '../../../lib/types';
  import type { SubmissionRecord, ResearcherRecord } from '../../../lib/db';
  import { createDefaultPriorityFilter } from '../../../lib/priority-filter';
  import { studyMatchesPriorityFilter, studyRewardMajor, studyHourlyRewardMajor, studyEstimatedMinutes } from '../../background/domain';
  import ResearcherPicker from './ResearcherPicker.svelte';
  import type { ResearcherProfile } from '../../../lib/researcher-profile';
  import type { EarningsPrefs } from '../../../lib/earnings-prefs';
  import { listCurrencies } from '../../../lib/earnings';
  import { cacheKey as fxCacheKey } from '../../../lib/fx-rates';
  import { SEED_CURRENCIES } from '../../../lib/constants';
  import {
    formatRelative,
    compactText,
    isAuthRequiredState,
    clampInt,
    normalizeRefreshPolicy,
    canonicalSoundType,
    cloneTelegramSettings,
  } from '../../../lib/format';
  import {
    PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH,
    DEFAULT_PRIORITY_ALERT_SOUND_TYPE,
    DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
    MIN_PRIORITY_ALERT_SOUND_VOLUME,
    MAX_PRIORITY_ALERT_SOUND_VOLUME,
    MIN_PRIORITY_FILTER_MIN_REWARD,
    MAX_PRIORITY_FILTER_MIN_REWARD,
    MIN_PRIORITY_FILTER_MIN_HOURLY_REWARD,
    MAX_PRIORITY_FILTER_MIN_HOURLY_REWARD,
    MIN_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
    MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES,
    MIN_PRIORITY_FILTER_MIN_PLACES,
    MAX_PRIORITY_FILTER_MIN_PLACES,
    MAX_PRIORITY_FILTER_KEYWORDS,
    MAX_PRIORITY_FILTERS,
    MIN_PRIORITY_FILTER_MIN_ESTIMATED_MINUTES,
    MAX_PRIORITY_FILTER_MIN_ESTIMATED_MINUTES,
    STUDY_TYPE_STANDARD,
    STUDY_TYPE_ONGOING,
    STUDY_TYPE_SCREENING,
    SOUND_TYPE_NONE,
    TELEGRAM_SETTINGS_PERSIST_DEBOUNCE_MS,
    TELEGRAM_VERIFY_DEBOUNCE_MS,
  } from '../../../lib/constants';

  let {
    active,
    autoOpenEnabled,
    priorityFilters = $bindable(),
    liveStudies,
    telegramSettings,
    savedRefreshPolicy,
    extensionState,
    refreshState,
    earningsPrefs,
    allSubmissions,
    knownResearchers,
    researcherProfiles,
    focusFilterId,
    onAutoOpenChange,
    onPriorityFiltersChange,
    onTelegramSettingsChange,
    onTelegramTest,
    onTelegramVerifyBot,
    onRefreshPolicySave,
    onRefreshDebug,
    onClearDebugLogs,
    onEarningsPrefsChange,
    onFilterFocused,
  } = $props<{
    active: boolean;
    autoOpenEnabled: boolean;
    priorityFilters: PriorityFilter[];
    liveStudies: Study[];
    telegramSettings: TelegramSettings;
    savedRefreshPolicy: NormalizedRefreshPolicy;
    extensionState: SyncState | null;
    refreshState: StudiesRefreshState | null;
    earningsPrefs: EarningsPrefs;
    allSubmissions: SubmissionRecord[];
    knownResearchers: ResearcherRecord[];
    researcherProfiles: Map<string, ResearcherProfile>;
    focusFilterId: string;
    onAutoOpenChange: (enabled: boolean) => void;
    onPriorityFiltersChange: () => void;
    onTelegramSettingsChange: (settings: TelegramSettings) => void;
    onTelegramTest: (settings: TelegramSettings) => Promise<{ ok: boolean; error?: string; description?: string }>;
    onTelegramVerifyBot: (botToken: string) => Promise<{ ok: boolean; bot_name?: string; bot_username?: string; error?: string }>;
    onRefreshPolicySave: (minDelay: number, avgDelay: number, spread: number) => void;
    onRefreshDebug: () => void;
    onClearDebugLogs: () => void;
    onEarningsPrefsChange: (prefs: EarningsPrefs) => void;
    onFilterFocused: () => void;
  }>();

  // Always show common currencies in the picker even with no data, so users
  // can configure FX pre-emptively. Detected currencies show submission counts.
  const detectedCurrencies = $derived(listCurrencies(allSubmissions));
  const topDetectedCurrency = $derived(detectedCurrencies[0]?.currency ?? 'USD');
  const activeCurrency = $derived(earningsPrefs.primary_currency ?? topDetectedCurrency);

  const currencyOptions = $derived.by(() => {
    const seen = new Map<string, number>();
    for (const c of detectedCurrencies) seen.set(c.currency, c.count);
    for (const code of SEED_CURRENCIES) if (!seen.has(code)) seen.set(code, 0);
    if (!seen.has(activeCurrency) && activeCurrency) seen.set(activeCurrency, 0);
    return [...seen.entries()]
      .map(([currency, count]) => ({ currency, count }))
      .sort((a, b) => b.count - a.count || a.currency.localeCompare(b.currency));
  });
  const otherCurrencies = $derived(currencyOptions.filter((c) => c.currency !== activeCurrency));

  function setPrimaryCurrency(code: string) {
    const normalized = code.trim().toUpperCase();
    onEarningsPrefsChange({
      ...earningsPrefs,
      primary_currency: normalized || null,
    });
  }

  function setFxRate(fromCurrency: string, rateStr: string) {
    const parsed = parseFloat(rateStr);
    const fx = { ...earningsPrefs.fx_rates };
    if (!Number.isFinite(parsed) || parsed <= 0) {
      delete fx[fromCurrency];
    } else {
      fx[fromCurrency] = parsed;
    }
    onEarningsPrefsChange({ ...earningsPrefs, fx_rates: fx });
  }

  function fxAgeLabel(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const diffMs = Date.now() - d.getTime();
    const hours = Math.round(diffMs / 3_600_000);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  // Track which filter is expanded (by id), empty string = none
  let expandedFilterId = $state('');

  $effect(() => {
    if (focusFilterId) {
      expandedFilterId = focusFilterId;
      untrack(() => {
        setTimeout(() => {
          const el = document.querySelector(`[data-filter-id="${focusFilterId}"]`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          onFilterFocused();
        }, 20);
      });
    }
  });

  function handleResearchersChange(filter: PriorityFilter, field: FilterListField, next: ResearcherRef[]) {
    if (field === 'match') {
      filter.match_researchers = next;
    } else {
      filter.ignore_researchers = next;
    }
    onPriorityFiltersChange();
  }

  // Local keyword text per filter — keeps text inputs editable without normalizing on every keystroke
  let keywordTextMap = $state(new Map<string, { match: string; ignore: string }>());
  let studyIdTextMap = $state(new Map<string, { match: string; ignore: string }>());

  function syncKeywordMaps(filters: PriorityFilter[]) {
    const activeIds = new Set<string>();
    for (const f of filters) {
      activeIds.add(f.id);
      if (!keywordTextMap.has(f.id)) {
        keywordTextMap.set(f.id, {
          match: Array.isArray(f.match_keywords) ? f.match_keywords.join(', ') : '',
          ignore: Array.isArray(f.ignore_keywords) ? f.ignore_keywords.join(', ') : '',
        });
      }
      if (!studyIdTextMap.has(f.id)) {
        studyIdTextMap.set(f.id, {
          match: Array.isArray(f.match_study_ids) ? f.match_study_ids.join(', ') : '',
          ignore: Array.isArray(f.ignore_study_ids) ? f.ignore_study_ids.join(', ') : '',
        });
      }
    }
    for (const id of keywordTextMap.keys()) {
      if (!activeIds.has(id)) {
        keywordTextMap.delete(id);
        studyIdTextMap.delete(id);
      }
    }
  }

  let previewExpandedFilterId = $state('');

  function filterPreviewMatches(filter: PriorityFilter): Study[] {
    if (!liveStudies.length) return [];
    return liveStudies.filter((s: Study) => studyMatchesPriorityFilter(s, filter));
  }

  const filterIds = $derived(priorityFilters.map((f: PriorityFilter) => f.id).join(','));

  $effect(() => {
    void filterIds;
    untrack(() => syncKeywordMaps(priorityFilters));
  });

  // Refresh sliders — local $state initialized from prop at mount time.
  // svelte-ignore state_referenced_locally
  let localMinDelay = $state(savedRefreshPolicy.minimum_delay_seconds);
  // svelte-ignore state_referenced_locally
  let localAvgDelay = $state(savedRefreshPolicy.average_delay_seconds);
  // svelte-ignore state_referenced_locally
  let localSpread = $state(savedRefreshPolicy.spread_seconds);

  // svelte-ignore state_referenced_locally — intentional: init from prop at mount
  let savedMin = $state(savedRefreshPolicy.minimum_delay_seconds);
  // svelte-ignore state_referenced_locally
  let savedAvg = $state(savedRefreshPolicy.average_delay_seconds);
  // svelte-ignore state_referenced_locally
  let savedSpread = $state(savedRefreshPolicy.spread_seconds);

  const localRefreshPolicy = $derived(normalizeRefreshPolicy(localMinDelay, localAvgDelay, localSpread));

  const hasUnsavedRefreshChanges = $derived(
    Number(localMinDelay) !== Number(savedMin) ||
    Number(localAvgDelay) !== Number(savedAvg) ||
    Number(localSpread) !== Number(savedSpread)
  );

  const refreshPlan = $derived(buildRefreshPlan(localRefreshPolicy));
  const refreshPlanSummary = $derived.by(() => {
    const delayLabels = refreshPlan.delays.length
      ? refreshPlan.delays.map((s) => `${Math.round(s)}s`).join(', ')
      : 'none within this cycle';
    return `Per ${localRefreshPolicy.cycle_seconds}s cycle: ${refreshPlan.count} extra refreshes at ${delayLabels}.`;
  });

  const debugRows = $derived(buildDebugRows(extensionState, refreshState));
  const debugLogs = $derived(buildDebugLogs(extensionState));

  let previewPlaying = $state(''); // filter id that's playing, or ''
  let previewAudioContext: AudioContext | null = null;
  let previewActiveSource: AudioBufferSourceNode | null = null;
  let previewResetTimer: ReturnType<typeof setTimeout> | null = null;
  let soundBase64Cache = new Map<string, Promise<string>>();
  let soundBufferCache = new Map<string, Promise<AudioBuffer>>();
  let soundBufferContext: AudioContext | null = null;

  const soundTypeOptions: { value: string; label: string }[] = [
    { value: SOUND_TYPE_NONE, label: 'None' },
    { value: 'pay', label: 'Pay' },
    { value: 'metal_gear', label: 'Metal Gear' },
    { value: 'twitch', label: 'Twitch' },
    { value: 'chime', label: 'Chime' },
    { value: 'money', label: 'Money' },
    { value: 'samsung', label: 'Samsung' },
    { value: 'lbp', label: 'LBP' },
    { value: 'taco', label: 'Taco' },
  ];

  const soundLabelByType = new Map(soundTypeOptions.map((o) => [o.value, o.label]));

  // svelte-ignore state_referenced_locally — init from prop at mount (parent gates with settingsLoaded)
  let tg = $state(cloneTelegramSettings(telegramSettings));

  let tgTestStatus = $state<'idle' | 'sending' | 'success' | 'error'>('idle');
  let tgTestError = $state('');
  let tgBotStatus = $state<'idle' | 'verifying' | 'valid' | 'invalid'>('idle');
  let tgBotName = $state('');
  let tgBotError = $state('');
  let tgSaveTimer: ReturnType<typeof setTimeout> | null = null;
  let tgVerifyTimer: ReturnType<typeof setTimeout> | null = null;
  let tgExpanded = $state(false);

  $effect(() => {
    return () => {
      if (tgSaveTimer) clearTimeout(tgSaveTimer);
      if (tgVerifyTimer) clearTimeout(tgVerifyTimer);
    };
  });

  const tgConfigured = $derived(tg.bot_token.length > 0 && tg.chat_id.length > 0);

  const tgFormatOptions: { key: keyof TelegramSettings['message_format']; label: string }[] = [
    { key: 'include_reward', label: 'Reward' },
    { key: 'include_hourly_rate', label: 'Hourly rate' },
    { key: 'include_duration', label: 'Duration' },
    { key: 'include_places', label: 'Places available' },
    { key: 'include_researcher', label: 'Researcher' },
    { key: 'include_tags', label: 'Study tags' },
    { key: 'include_description', label: 'Description' },
    { key: 'include_link', label: 'Open study button' },
  ];

  function snapshotTelegramSettings(): TelegramSettings {
    const s = cloneTelegramSettings(tg);
    s.bot_token = s.bot_token.trim();
    s.chat_id = s.chat_id.trim();
    return s;
  }

  function debounceTelegramSave() {
    if (tgSaveTimer) clearTimeout(tgSaveTimer);
    tgSaveTimer = setTimeout(() => {
      tgSaveTimer = null;
      onTelegramSettingsChange(snapshotTelegramSettings());
    }, TELEGRAM_SETTINGS_PERSIST_DEBOUNCE_MS);
  }

  function debounceBotVerify() {
    if (tgVerifyTimer) clearTimeout(tgVerifyTimer);
    tgBotStatus = 'idle';
    tgBotName = '';
    tgBotError = '';
    const token = tg.bot_token.trim();
    if (!token) return;
    tgVerifyTimer = setTimeout(async () => {
      tgVerifyTimer = null;
      tgBotStatus = 'verifying';
      const result = await onTelegramVerifyBot(token);
      if (tg.bot_token.trim() !== token) return;
      if (result.ok) {
        tgBotStatus = 'valid';
        tgBotName = result.bot_username ? `@${result.bot_username}` : result.bot_name || '';
      } else {
        tgBotStatus = 'invalid';
        tgBotError = result.error || 'Verification failed';
      }
    }, TELEGRAM_VERIFY_DEBOUNCE_MS);
  }

  function handleBotTokenInput() {
    debounceTelegramSave();
    debounceBotVerify();
  }

  async function handleTgTestClick() {
    tgTestStatus = 'sending';
    tgTestError = '';
    const result = await onTelegramTest(snapshotTelegramSettings());
    if (result.ok) {
      tgTestStatus = 'success';
      setTimeout(() => { if (tgTestStatus === 'success') tgTestStatus = 'idle'; }, 3000);
    } else {
      tgTestStatus = 'error';
      tgTestError = result.description || result.error || 'Unknown error';
      setTimeout(() => { if (tgTestStatus === 'error') tgTestStatus = 'idle'; }, 5000);
    }
  }

  const DEBUG_EVENT_LABELS: Record<string, string> = {
    'token.sync.ok': 'Token synced',
    'token.sync.error': 'Token sync failed',
    'oauth.capture.ok': 'OAuth token captured',
    'studies.refresh.post.ok': 'Refresh forwarded',
    'studies.refresh.post.error': 'Refresh forward failed',
    'studies.response.ingest.ok': 'Response ingested',
    'studies.response.ingest.error': 'Response ingest failed',
    'studies.response.parse.error': 'Response parse failed',
    'studies.response.filter.error': 'Response capture failed',
    'studies.response.capture.on_parsed_error': 'Response parse hook failed',
    'settings.auto_open.updated': 'Auto-open updated',
    'settings.priority_filters.updated': 'Priority filters saved',
    'priority.dry_run': 'Test mode match (no action)',
    'priority.alert.disabled': 'Priority alert disabled',
    'tab.priority_auto_open.created': 'Priority study opened',
    'tab.priority_auto_open.disabled_new_tab': 'Priority tab auto-open disabled',
    'tab.priority_auto_open.error': 'Priority auto-open failed',
    'priority.alert.played': 'Priority alert played',
    'priority.alert.error': 'Priority alert failed',
    'settings.studies_refresh_policy.updated': 'Cadence saved',
    'settings.studies_refresh_policy.schedule_ok': 'Cadence schedule applied',
    'settings.telegram.updated': 'Telegram settings saved',
    'telegram.notify.sent': 'Telegram notification sent',
    'telegram.notify.error': 'Telegram notification failed',
    'telegram.test.sent': 'Telegram test sent',
    'telegram.test.error': 'Telegram test failed',
  };

  function normalizePriorityKeywords(value: string): string[] {
    const values = String(value || '').split(',');
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const item of values) {
      const keyword = item.trim().toLowerCase();
      if (!keyword || seen.has(keyword)) continue;
      seen.add(keyword);
      unique.push(keyword);
      if (unique.length >= MAX_PRIORITY_FILTER_KEYWORDS) break;
    }
    return unique;
  }

  function normalizeStudyIdList(text: string): string[] {
    const values = text.split(',');
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const item of values) {
      const id = item.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    return unique;
  }

  function handleFilterInput(filter: PriorityFilter) {
    const kw = keywordTextMap.get(filter.id);
    filter.match_keywords = normalizePriorityKeywords(kw?.match || '');
    filter.ignore_keywords = normalizePriorityKeywords(kw?.ignore || '');
    const sid = studyIdTextMap.get(filter.id);
    filter.match_study_ids = normalizeStudyIdList(sid?.match || '');
    filter.ignore_study_ids = normalizeStudyIdList(sid?.ignore || '');
    onPriorityFiltersChange();
  }

  function handleKeywordInput(filter: PriorityFilter, field: FilterListField, value: string) {
    const kw = keywordTextMap.get(filter.id) || { match: '', ignore: '' };
    kw[field] = value;
    keywordTextMap.set(filter.id, kw);
    handleFilterInput(filter);
  }

  function handleStudyIdInput(filter: PriorityFilter, field: FilterListField, value: string) {
    const sid = studyIdTextMap.get(filter.id) || { match: '', ignore: '' };
    sid[field] = value;
    studyIdTextMap.set(filter.id, sid);
    handleFilterInput(filter);
  }

  function handleStudyTypeToggle(filter: PriorityFilter, studyType: string, checked: boolean) {
    let current = Array.isArray(filter.allowed_study_types) && filter.allowed_study_types.length
      ? [...filter.allowed_study_types]
      : [STUDY_TYPE_STANDARD, STUDY_TYPE_ONGOING, STUDY_TYPE_SCREENING];
    if (checked && !current.includes(studyType)) {
      current.push(studyType);
    } else if (!checked) {
      current = current.filter((t: string) => t !== studyType);
    }
    // All three checked = no restriction (empty array)
    if (current.length >= 3) current = [];
    filter.allowed_study_types = current;
    handleFilterInput(filter);
  }

  function handleSoundControlChange(filter: PriorityFilter) {
    filter.alert_sound_enabled = filter.alert_sound_type !== SOUND_TYPE_NONE;
    cancelPreview();
    handleFilterInput(filter);
  }

  function handleAddFilter() {
    if (priorityFilters.length >= MAX_PRIORITY_FILTERS) return;
    const newFilter = createDefaultPriorityFilter({ name: `Filter ${priorityFilters.length + 1}` });
    keywordTextMap.set(newFilter.id, { match: '', ignore: '' });
    studyIdTextMap.set(newFilter.id, { match: '', ignore: '' });
    priorityFilters = [...priorityFilters, newFilter];
    expandedFilterId = newFilter.id;
    onPriorityFiltersChange();
  }

  let deleteConfirmId = $state('');
  let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

  function handleDeleteFilter(filterId: string) {
    if (deleteConfirmId !== filterId) {
      deleteConfirmId = filterId;
      if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = setTimeout(() => { deleteConfirmId = ''; }, 3000);
      return;
    }
    if (deleteConfirmTimer) clearTimeout(deleteConfirmTimer);
    deleteConfirmId = '';
    priorityFilters = priorityFilters.filter((f: PriorityFilter) => f.id !== filterId);
    keywordTextMap.delete(filterId);
    studyIdTextMap.delete(filterId);
    if (expandedFilterId === filterId) expandedFilterId = '';
    onPriorityFiltersChange();
  }

  function toggleFilterExpanded(filterId: string) {
    expandedFilterId = expandedFilterId === filterId ? '' : filterId;
  }

  interface FilterBadge { label: string; muted?: boolean }

  function filterBadges(f: PriorityFilter): FilterBadge[] {
    const badges: FilterBadge[] = [];
    if (f.minimum_reward_major > 0) badges.push({ label: `$${f.minimum_reward_major}+` });
    if (f.minimum_hourly_reward_major > 0) badges.push({ label: `$${f.minimum_hourly_reward_major}/hr` });
    if (f.maximum_estimated_minutes < MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES) badges.push({ label: `\u2264${f.maximum_estimated_minutes}m` });
    if (f.minimum_estimated_minutes > 0) badges.push({ label: `\u2265${f.minimum_estimated_minutes}m` });
    if (f.allowed_study_types?.length) badges.push({ label: f.allowed_study_types.join('/') });
    if (f.match_keywords.length) badges.push({ label: `${f.match_keywords.length} kw` });
    const researcherCount = (f.match_researchers?.length || 0) + (f.ignore_researchers?.length || 0);
    if (researcherCount > 0) badges.push({ label: `${researcherCount} r` });
    const studyIdCount = (f.match_study_ids?.length || 0) + (f.ignore_study_ids?.length || 0);
    if (studyIdCount > 0) badges.push({ label: `${studyIdCount} ids` });
    if (f.dry_run) badges.push({ label: 'test mode' });
    if (f.auto_open_in_new_tab) badges.push({ label: 'auto-open' });
    if (f.desktop_notify) badges.push({ label: 'desktop' });
    if (f.telegram_notify && tg.enabled) badges.push({ label: 'telegram' });
    if (f.quiet_hours_enabled) badges.push({ label: `quiet ${f.quiet_hours_start}–${f.quiet_hours_end}` });
    if (f.alert_sound_type !== SOUND_TYPE_NONE && f.alert_sound_enabled) {
      const soundLabel = soundLabelByType.get(f.alert_sound_type) ?? f.alert_sound_type;
      badges.push({ label: soundLabel });
    } else {
      badges.push({ label: 'silent', muted: true });
    }
    return badges;
  }

  // Refresh slider handlers
  function handleRefreshSliderInput() {
    const policy = normalizeRefreshPolicy(localMinDelay, localAvgDelay, localSpread);
    localMinDelay = policy.minimum_delay_seconds;
    localAvgDelay = policy.average_delay_seconds;
    localSpread = policy.spread_seconds;
  }

  function refreshCardActions(node: HTMLElement) {
    function onClick(e: Event) {
      const target = e.target as HTMLElement;
      if (target.closest('#refreshCadenceSaveButton')) handleRefreshSave();
      else if (target.closest('#refreshCadenceRevertButton')) handleRefreshRevert();
    }
    node.addEventListener('click', onClick);
    return { destroy() { node.removeEventListener('click', onClick); } };
  }

  function handleRefreshSave() {
    onRefreshPolicySave(
      localRefreshPolicy.minimum_delay_seconds,
      localRefreshPolicy.average_delay_seconds,
      localRefreshPolicy.spread_seconds,
    );
    savedMin = Number(localMinDelay);
    savedAvg = Number(localAvgDelay);
    savedSpread = Number(localSpread);
  }

  function handleRefreshRevert() {
    const policy = normalizeRefreshPolicy(
      savedRefreshPolicy.minimum_delay_seconds,
      savedRefreshPolicy.average_delay_seconds,
      savedRefreshPolicy.spread_seconds,
    );
    localMinDelay = policy.minimum_delay_seconds;
    localAvgDelay = policy.average_delay_seconds;
    localSpread = policy.spread_seconds;
    savedMin = localMinDelay;
    savedAvg = localAvgDelay;
    savedSpread = localSpread;
  }

  function buildRefreshPlan(policy: NormalizedRefreshPolicy): { delays: number[]; windows: { left: number; right: number }[]; count: number } {
    const cycle = policy.cycle_seconds;
    const minimum = policy.minimum_delay_seconds;
    const average = policy.average_delay_seconds;
    const spread = policy.spread_seconds;

    const maxCountByMinimum = Math.max(0, Math.floor(cycle / minimum) - 1);
    const maxCountByAverage = Math.max(0, Math.floor(cycle / average) - 1);
    const count = Math.max(0, Math.min(maxCountByMinimum, maxCountByAverage));

    if (count <= 0) return { delays: [], windows: [], count: 0 };

    const delays: number[] = [];
    const segments = count + 1;
    for (let i = 1; i <= count; i++) delays.push((cycle * i) / segments);

    const windows = delays.map((center, idx) => {
      const previous = idx === 0 ? 0 : delays[idx - 1];
      const next = idx === delays.length - 1 ? cycle : delays[idx + 1];
      const minLeft = previous + minimum;
      const maxRight = next - minimum;
      const left = Math.max(minLeft, center - spread);
      const right = Math.min(maxRight, center + spread);
      return { left: Math.min(left, right), right: Math.max(left, right) };
    });

    return { delays, windows, count };
  }

  function trackPct(seconds: number): number {
    return Math.max(0, Math.min(100, (seconds / localRefreshPolicy.cycle_seconds) * 100));
  }

  function formatDebugTime(value: unknown): string {
    return formatRelative(value);
  }

  function formatAuthStatus(state: SyncState | null): string {
    if (!state) return 'n/a';
    if (isAuthRequiredState(state)) return 'signed out';
    if (state.token_ok === true) return 'connected';
    if (state.token_ok === false) return 'degraded';
    return 'n/a';
  }

  function formatCadenceSummary(state: SyncState | null): string {
    if (!state) return 'n/a';
    const minD = Number(state.studies_refresh_min_delay_seconds);
    const avgD = Number(state.studies_refresh_average_delay_seconds);
    const sp = Number(state.studies_refresh_spread_seconds);
    if (!Number.isFinite(minD) || !Number.isFinite(avgD) || !Number.isFinite(sp)) return 'n/a';
    return `min ${minD}s \u00b7 avg ${avgD}s \u00b7 spread ${sp}s`;
  }

  function formatDebugIssue(state: SyncState | null): string {
    if (!state) return 'none';
    if (isAuthRequiredState(state)) return 'waiting for login';
    if (state.token_ok === false) return compactText(String(state.token_reason || 'token sync failed'));
    if (state.studies_refresh_ok === false) return compactText(String(state.studies_refresh_reason || 'refresh sync failed'));
    if (state.studies_response_capture_ok === false) {
      return compactText(String(state.studies_response_capture_reason || 'response capture failed'));
    }
    return 'none';
  }

  function buildDebugRows(state: SyncState | null, refresh: StudiesRefreshState | null): [string, string][] {
    const s = state || {} as SyncState;
    const r = refresh || {} as StudiesRefreshState;
    return [
      ['Auth', formatAuthStatus(state)],
      ['Token Sync', formatDebugTime(s.token_last_success_at)],
      ['Last Refresh', formatDebugTime(r.last_studies_refresh_at)],
      ['Refresh Source', r.last_studies_refresh_source || 'n/a'],
      ['Cadence', formatCadenceSummary(state)],
      ['Last Issue', formatDebugIssue(state)],
      ['Log Entries', String(Number(s.debug_log_count_total) || 0)],
    ];
  }

  function formatDebugLogEvent(eventName: string): string {
    return DEBUG_EVENT_LABELS[eventName] || eventName || 'unknown';
  }

  function formatDebugLogDetails(entry: DebugLogEntry): string {
    const details = entry.details;
    if (!details) return '';
    if (details.error) return ` \u00b7 ${compactText(String(details.error), 96)}`;
    if (typeof details.status_code === 'number') return ` \u00b7 HTTP ${details.status_code}`;
    if (details.trigger) return ` \u00b7 ${String(details.trigger)}`;
    if (details.reason) return ` \u00b7 ${compactText(String(details.reason), 96)}`;
    return '';
  }

  function buildDebugLogs(state: SyncState | null): { at: string; label: string; suffix: string }[] {
    if (!state) return [];
    const logs = Array.isArray(state.debug_logs) ? state.debug_logs : [];
    return logs.slice(0, 30).map((entry) => {
      const at = formatRelative(entry.at, true);
      const label = formatDebugLogEvent(entry.event);
      const repeatCount = Math.max(1, Number(entry.repeat_count) || 1);
      const repeatLabel = repeatCount > 1 ? ` (x${repeatCount})` : '';
      const details = formatDebugLogDetails(entry);
      return { at, label, suffix: repeatLabel + details };
    });
  }

  function getPreviewAudioContext(): AudioContext | null {
    const AudioContextCtor = globalThis.AudioContext || (globalThis as any).webkitAudioContext;
    if (!AudioContextCtor) return null;
    if (previewAudioContext) return previewAudioContext;
    try {
      previewAudioContext = new AudioContextCtor();
      return previewAudioContext;
    } catch {
      return null;
    }
  }

  async function getSoundBase64(soundType: string): Promise<string> {
    const normalized = canonicalSoundType(soundType);
    if (!soundBase64Cache.has(normalized)) {
      const path = PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH[normalized] || PRIORITY_ALERT_SOUND_TYPE_TO_BASE64_PATH[DEFAULT_PRIORITY_ALERT_SOUND_TYPE];
      soundBase64Cache.set(normalized, (async () => {
        const response = await fetch(browser.runtime.getURL(path));
        if (!response.ok) throw new Error(`Failed to load ${normalized} sound.`);
        return (await response.text()).replace(/\s+/g, '');
      })());
    }
    return soundBase64Cache.get(normalized)!;
  }

  async function getSoundBuffer(audioContext: AudioContext, soundType: string): Promise<AudioBuffer> {
    const normalized = canonicalSoundType(soundType);
    if (soundBufferContext !== audioContext) {
      soundBufferContext = audioContext;
      soundBufferCache = new Map();
    }
    if (!soundBufferCache.has(normalized)) {
      soundBufferCache.set(normalized, (async () => {
        const base64 = await getSoundBase64(normalized);
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;
        return await audioContext.decodeAudioData(arrayBuffer);
      })());
    }
    return soundBufferCache.get(normalized)!;
  }

  function cancelPreview() {
    if (previewActiveSource) {
      try { previewActiveSource.stop(); } catch {}
      previewActiveSource = null;
    }
    if (previewResetTimer) {
      clearTimeout(previewResetTimer);
      previewResetTimer = null;
    }
    previewPlaying = '';
  }

  async function handlePreviewClick(filter: PriorityFilter) {
    if (previewPlaying === filter.id) { cancelPreview(); return; }
    cancelPreview();

    const audioContext = getPreviewAudioContext();
    if (!audioContext) return;
    if (audioContext.state === 'suspended' && typeof audioContext.resume === 'function') {
      await audioContext.resume();
    }

    const soundType = canonicalSoundType(filter.alert_sound_type ?? DEFAULT_PRIORITY_ALERT_SOUND_TYPE);
    const soundVolume = clampInt(
      filter.alert_sound_volume ?? DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
      MIN_PRIORITY_ALERT_SOUND_VOLUME,
      MAX_PRIORITY_ALERT_SOUND_VOLUME,
      DEFAULT_PRIORITY_ALERT_SOUND_VOLUME,
    ) / 100;
    if (soundVolume <= 0) return;

    const startTime = audioContext.currentTime + 0.03;
    const soundBuffer = await getSoundBuffer(audioContext, soundType);
    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    source.buffer = soundBuffer;
    source.loop = false;
    gainNode.gain.setValueAtTime(Math.max(0, Math.min(2.5, Math.pow(soundVolume, 0.55) * 2.2)), startTime);
    source.connect(gainNode);
    gainNode.connect(audioContext.destination);
    source.onended = () => {
      try { source.disconnect(); gainNode.disconnect(); } catch {}
    };

    previewPlaying = filter.id;
    previewActiveSource = source;
    previewResetTimer = setTimeout(() => {
      previewResetTimer = null;
      previewPlaying = '';
    }, Math.max(300, Math.ceil((Math.max(0.1, soundBuffer.duration) + 0.12) * 1000) + 180));
    source.start(startTime);
  }

</script>

<div id="panelSettings" class="panel" class:active role="tabpanel" aria-labelledby="tabSettings">
  <div class="settings min-h-[420px] max-h-[420px] scroll-container pb-1">
    <!-- Auto-open card -->
    <div class="setting-card bg-base-100 shadow-sm border border-base-300 rounded-lg p-4 flex items-center justify-between gap-3 mb-2.5">
      <div>
        <div class="text-sm font-semibold text-base-content">Auto-open Prolific tab</div>
        <div class="text-xs text-base-content/50 mt-0.5 leading-snug">Keeps a background Prolific tab alive when none are open.</div>
      </div>
      <input
        id="autoOpenToggle"
        type="checkbox"
        class="toggle toggle-primary toggle-sm"
        checked={autoOpenEnabled}
        aria-label="Auto-open Prolific tab"
        onchange={(e) => onAutoOpenChange((e.target as HTMLInputElement).checked)}
      />
    </div>

    <!-- Earnings card -->
    <div class="setting-card bg-base-100 shadow-sm border border-base-300 rounded-lg p-4 mb-2.5">
      <div class="text-sm font-semibold text-base-content">Earnings</div>
      <div class="text-xs text-base-content/50 mt-0.5 leading-snug mb-3">Pick the currency your totals are shown in. Other currencies are converted using the rates you enter below.</div>

      <div class="flex items-center gap-2 flex-wrap">
        <label class="text-xs text-base-content/70 font-medium" for="earningsDefaultCurrency">Default currency</label>
        <select
          id="earningsDefaultCurrency"
          class="select select-bordered select-sm"
          value={activeCurrency}
          onchange={(e) => setPrimaryCurrency((e.target as HTMLSelectElement).value)}
        >
          {#each currencyOptions as c (c.currency)}
            <option value={c.currency}>
              {c.currency}{c.count > 0 ? ` · ${c.count} submission${c.count === 1 ? '' : 's'}` : ''}
            </option>
          {/each}
        </select>
      </div>

      {#if otherCurrencies.length > 0}
        <div class="mt-3 pt-3 border-t border-base-300">
          <div class="text-[11.5px] font-semibold text-base-content/70 mb-1.5">Conversion rates</div>
          <div class="flex flex-col gap-1.5">
            {#each otherCurrencies as c (c.currency)}
              {@const manualRate = earningsPrefs.fx_rates[c.currency]}
              {@const cached = earningsPrefs.fx_rates_cache[fxCacheKey(c.currency, activeCurrency)]}
              {@const isManual = Number.isFinite(manualRate) && manualRate > 0}
              {@const displayRate = isManual ? manualRate : (cached?.rate ?? '')}
              <div class="flex items-center gap-2 text-xs">
                <span class="text-base-content/55 w-20">1 {c.currency} =</span>
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  class="input input-bordered input-xs w-24 text-right"
                  placeholder={cached ? cached.rate.toFixed(4) : 'fetching…'}
                  value={isManual ? manualRate : ''}
                  onchange={(e) => setFxRate(c.currency, (e.target as HTMLInputElement).value)}
                />
                <span class="text-base-content/55">{activeCurrency}</span>
                {#if isManual}
                  <span class="badge badge-xs badge-warning text-[9.5px] font-semibold">manual</span>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs px-1 h-5 min-h-0 text-[10px] text-base-content/55"
                    onclick={() => setFxRate(c.currency, '')}
                    title="Clear override, use auto rate"
                  >reset</button>
                {:else if cached}
                  <span class="badge badge-xs badge-ghost text-[9.5px]" title={`Fetched ${new Date(cached.fetched_at).toLocaleString()} · ECB via Frankfurter`}>auto · {fxAgeLabel(cached.fetched_at)}</span>
                {:else}
                  <span class="badge badge-xs badge-error text-[9.5px]" title="Auto-fetch pending or failed; enter a rate to override">—</span>
                {/if}
                <span class="text-[10.5px] text-base-content/40 ml-auto">{c.count > 0 ? `${c.count} sub${c.count === 1 ? '' : 's'}` : ''}</span>
              </div>
            {/each}
          </div>
          <div class="text-[10.5px] text-base-content/45 mt-1.5 leading-snug">
            Rates update automatically. Enter a value to override.
          </div>
        </div>
      {/if}
    </div>

    <!-- Priority filters -->
    <div class="setting-card bg-base-100 shadow-sm border border-base-300 rounded-lg p-4 mb-2.5">
      <div class="flex items-center justify-between gap-2.5 mb-0.5">
        <div class="text-sm font-semibold text-base-content">Priority filters</div>
        {#if priorityFilters.length > 0}
          <button
            id="addFilterButton"
            class="btn btn-ghost btn-xs text-xs font-semibold text-primary"
            type="button"
            disabled={priorityFilters.length >= MAX_PRIORITY_FILTERS}
            onclick={handleAddFilter}
          >+ Add</button>
        {/if}
      </div>
      <div class="text-xs text-base-content/50 leading-snug mb-3">Alert and auto-open when new studies match a filter. Adding a "match" keyword or researcher scopes a filter to only those studies. If multiple filters match, the most specific one wins (scoped filters beat open ones, louder alerts beat silent).</div>

      {#if !priorityFilters.length}
        <button
          id="addFilterButton"
          class="w-full py-3.5 border-2 border-dashed border-base-300 rounded-lg text-xs text-base-content/40 hover:border-primary/40 hover:text-primary/60 transition-colors cursor-pointer bg-transparent"
          type="button"
          onclick={handleAddFilter}
        >+ Create your first filter</button>
      {/if}

      <div class="flex flex-col gap-2">
        {#each priorityFilters as filter, idx (filter.id)}
          {@const isExpanded = expandedFilterId === filter.id}
          {@const isPreviewPlaying = previewPlaying === filter.id}
          {@const previewDisabled = !isPreviewPlaying && (filter.alert_sound_type === SOUND_TYPE_NONE || filter.alert_sound_volume <= 0)}
          {@const isConfirmingDelete = deleteConfirmId === filter.id}
          <div
            class="filter-card rounded-lg border {isExpanded ? 'bg-base-100 border-base-300 shadow-sm' : filter.enabled ? 'bg-base-100 border-primary/25' : 'bg-base-200/50 border-base-300'}"
            class:opacity-45={!filter.enabled && !isExpanded}
            data-filter-id={filter.id}
          >
            <div class="flex items-center gap-1.5 px-3 py-2">
              <button
                class="filter-arrow-btn btn btn-ghost btn-xs w-5 h-5 min-h-0 p-0 text-[9px] text-base-content/25"
                type="button"
                aria-label={isExpanded ? 'Collapse filter' : 'Expand filter'}
                onclick={() => toggleFilterExpanded(filter.id)}
              ><span class="filter-arrow inline-block transition-transform" class:rotate-90={isExpanded}>&#9654;</span></button>
              {#if isExpanded}
                <input
                  type="text"
                  class="input input-ghost input-xs flex-1 text-[12.5px] font-semibold min-w-0 px-1.5 h-7 rounded bg-base-200/60"
                  spellcheck="false"
                  placeholder="Filter name"
                  bind:value={filter.name}
                  oninput={() => onPriorityFiltersChange()}
                  aria-label="Filter name"
                />
              {:else}
                <button
                  class="filter-header flex-1 text-left bg-transparent border-none cursor-pointer p-0 min-w-0"
                  type="button"
                  onclick={() => toggleFilterExpanded(filter.id)}
                >
                  <span class="text-[12.5px] font-semibold text-base-content truncate block">{filter.name}</span>
                </button>
                {@const badges = filterBadges(filter)}
                <span class="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end max-w-[55%]">
                  {#each badges.slice(0, 5) as badge (badge.label)}
                    <span class="inline-block text-[10px] px-1.5 py-[1px] rounded-full font-medium whitespace-nowrap leading-tight {badge.muted ? 'bg-base-content/5 text-base-content/30' : 'bg-base-content/7 text-base-content/50'}"
                    >{badge.label}</span>
                  {/each}
                </span>
              {/if}
              <input
                id="priorityFilterEnabledToggle-{idx}"
                type="checkbox"
                class="toggle toggle-primary toggle-xs"
                aria-label="Enable filter"
                bind:checked={filter.enabled}
                onchange={() => handleFilterInput(filter)}
              />
              <button
                class="btn btn-ghost btn-xs min-h-0 h-6 text-[10px] transition-colors {isConfirmingDelete ? 'text-error font-bold px-2' : 'text-base-content/20 hover:text-error/60 px-1'}"
                type="button"
                aria-label={isConfirmingDelete ? 'Confirm delete' : 'Delete filter'}
                title={isConfirmingDelete ? 'Click again to confirm' : 'Delete filter'}
                onclick={() => handleDeleteFilter(filter.id)}
              >{isConfirmingDelete ? 'Delete?' : '\u00d7'}</button>
            </div>

            {#if isExpanded}
            {@const previewMatches = filterPreviewMatches(filter)}
            {@const isPreviewExpanded = previewExpandedFilterId === filter.id}
            <div class="px-3 pb-3 pt-0.5 flex flex-col gap-2">
              <div class="grid grid-cols-[100px_1fr_100px_1fr] items-center gap-x-2 gap-y-1.5">
                <label for="priorityMinRewardInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Min reward</label>
                <input
                  id="priorityMinRewardInput-{idx}"
                  type="number"
                  class="input input-xs w-full tabular-nums"
                  min={MIN_PRIORITY_FILTER_MIN_REWARD}
                  max={MAX_PRIORITY_FILTER_MIN_REWARD}
                  step="0.1"
                  bind:value={filter.minimum_reward_major}
                  oninput={() => handleFilterInput(filter)}
                />
                <label for="priorityMinHourlyInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Min reward/hr</label>
                <input
                  id="priorityMinHourlyInput-{idx}"
                  type="number"
                  class="input input-xs w-full tabular-nums"
                  min={MIN_PRIORITY_FILTER_MIN_HOURLY_REWARD}
                  max={MAX_PRIORITY_FILTER_MIN_HOURLY_REWARD}
                  step="0.5"
                  bind:value={filter.minimum_hourly_reward_major}
                  oninput={() => handleFilterInput(filter)}
                />
                <label for="priorityMaxEtaInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Max ETA (mins)</label>
                <input
                  id="priorityMaxEtaInput-{idx}"
                  type="number"
                  class="input input-xs w-full tabular-nums"
                  min={MIN_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES}
                  max={MAX_PRIORITY_FILTER_MAX_ESTIMATED_MINUTES}
                  step="1"
                  bind:value={filter.maximum_estimated_minutes}
                  oninput={() => handleFilterInput(filter)}
                />
                <label for="priorityMinEtaInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Min ETA (mins)</label>
                <input
                  id="priorityMinEtaInput-{idx}"
                  type="number"
                  class="input input-xs w-full tabular-nums"
                  min={MIN_PRIORITY_FILTER_MIN_ESTIMATED_MINUTES}
                  max={MAX_PRIORITY_FILTER_MIN_ESTIMATED_MINUTES}
                  step="1"
                  bind:value={filter.minimum_estimated_minutes}
                  oninput={() => handleFilterInput(filter)}
                />
                <label for="priorityMinPlacesInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Min places</label>
                <input
                  id="priorityMinPlacesInput-{idx}"
                  type="number"
                  class="input input-xs w-full tabular-nums"
                  min={MIN_PRIORITY_FILTER_MIN_PLACES}
                  max={MAX_PRIORITY_FILTER_MIN_PLACES}
                  step="1"
                  bind:value={filter.minimum_places_available}
                  oninput={() => handleFilterInput(filter)}
                />
              </div>

              <div class="grid grid-cols-2 gap-x-2">
                <div>
                  <label for="priorityAlwaysKeywordsInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium block mb-0.5">Match keywords</label>
                  <input
                    id="priorityAlwaysKeywordsInput-{idx}"
                    type="text"
                    class="input input-xs w-full lowercase"
                    spellcheck="false"
                    placeholder="ai, survey"
                    value={keywordTextMap.get(filter.id)?.match || ''}
                    oninput={(e) => handleKeywordInput(filter, 'match', (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label for="priorityIgnoreKeywordsInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium block mb-0.5">Ignore keywords</label>
                  <input
                    id="priorityIgnoreKeywordsInput-{idx}"
                    type="text"
                    class="input input-xs w-full lowercase"
                    spellcheck="false"
                    placeholder="webcam, screened"
                    value={keywordTextMap.get(filter.id)?.ignore || ''}
                    oninput={(e) => handleKeywordInput(filter, 'ignore', (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>

              <div class="grid grid-cols-2 gap-x-2 gap-y-1">
                <div>
                  <div class="text-[12.5px] text-base-content/50 font-medium mb-0.5">Match researchers</div>
                  <ResearcherPicker
                    selected={filter.match_researchers ?? []}
                    {knownResearchers}
                    profiles={researcherProfiles}
                    tone="positive"
                    placeholder="Add researcher"
                    onChange={(next) => handleResearchersChange(filter, 'match', next)}
                  />
                </div>
                <div>
                  <div class="text-[12.5px] text-base-content/50 font-medium mb-0.5">Ignore researchers</div>
                  <ResearcherPicker
                    selected={filter.ignore_researchers ?? []}
                    {knownResearchers}
                    profiles={researcherProfiles}
                    tone="negative"
                    placeholder="Add researcher"
                    onChange={(next) => handleResearchersChange(filter, 'ignore', next)}
                  />
                </div>
              </div>

              <div class="grid grid-cols-2 gap-x-2">
                <div>
                  <label for="priorityMatchStudyIdsInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium block mb-0.5">Match study IDs</label>
                  <input
                    id="priorityMatchStudyIdsInput-{idx}"
                    type="text"
                    class="input input-xs w-full font-mono text-[11px]"
                    spellcheck="false"
                    placeholder="from Prolific URL"
                    value={studyIdTextMap.get(filter.id)?.match || ''}
                    oninput={(e) => handleStudyIdInput(filter, 'match', (e.target as HTMLInputElement).value)}
                  />
                </div>
                <div>
                  <label for="priorityIgnoreStudyIdsInput-{idx}" class="text-[12.5px] text-base-content/50 font-medium block mb-0.5">Ignore study IDs</label>
                  <input
                    id="priorityIgnoreStudyIdsInput-{idx}"
                    type="text"
                    class="input input-xs w-full font-mono text-[11px]"
                    spellcheck="false"
                    placeholder="from Prolific URL"
                    value={studyIdTextMap.get(filter.id)?.ignore || ''}
                    oninput={(e) => handleStudyIdInput(filter, 'ignore', (e.target as HTMLInputElement).value)}
                  />
                </div>
              </div>

              <div>
                <div class="text-[12.5px] text-base-content/50 font-medium mb-1">Study types</div>
                <div class="flex items-center gap-3">
                  <label class="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs checkbox-primary"
                      checked={!filter.allowed_study_types?.length || filter.allowed_study_types.includes(STUDY_TYPE_STANDARD)}
                      onchange={(e) => handleStudyTypeToggle(filter, STUDY_TYPE_STANDARD, (e.target as HTMLInputElement).checked)}
                    />
                    <span class="text-[12px] text-base-content/60">Standard</span>
                  </label>
                  <label class="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs checkbox-primary"
                      checked={!filter.allowed_study_types?.length || filter.allowed_study_types.includes(STUDY_TYPE_ONGOING)}
                      onchange={(e) => handleStudyTypeToggle(filter, STUDY_TYPE_ONGOING, (e.target as HTMLInputElement).checked)}
                    />
                    <span class="text-[12px] text-base-content/60">Ongoing</span>
                  </label>
                  <label class="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      class="checkbox checkbox-xs checkbox-primary"
                      checked={!filter.allowed_study_types?.length || filter.allowed_study_types.includes(STUDY_TYPE_SCREENING)}
                      onchange={(e) => handleStudyTypeToggle(filter, STUDY_TYPE_SCREENING, (e.target as HTMLInputElement).checked)}
                    />
                    <span class="text-[12px] text-base-content/60">Screening</span>
                  </label>
                </div>
                {#if filter.allowed_study_types?.length}
                  <div class="text-[10.5px] text-base-content/35 mt-0.5">Only studies of checked types will match.</div>
                {/if}
              </div>

              {#if (filter.match_keywords?.length || 0) + (filter.match_researchers?.length || 0) + (filter.match_study_ids?.length || 0) > 0}
                <div class="text-[10.5px] text-base-content/45 leading-snug -mt-0.5">
                  This filter is scoped to studies matching a "match" entry. Other studies won't trigger it.
                </div>
              {/if}

              <div class="grid grid-cols-[100px_1fr] items-center gap-x-2 gap-y-1.5">
                <label for="priorityDryRunToggle-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Test mode</label>
                <div class="flex items-center gap-2">
                  <input
                    id="priorityDryRunToggle-{idx}"
                    type="checkbox"
                    class="toggle toggle-warning toggle-xs"
                    aria-label="Test mode"
                    bind:checked={filter.dry_run}
                    onchange={() => handleFilterInput(filter)}
                  />
                  {#if filter.dry_run}
                    <span class="text-[10px] text-warning">Matches are logged but won't trigger sounds or tabs</span>
                  {/if}
                </div>
                <label for="priorityAutoOpenInNewTabToggle-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Auto-open tab</label>
                <div>
                  <input
                    id="priorityAutoOpenInNewTabToggle-{idx}"
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                    aria-label="Auto-open in new tab"
                    bind:checked={filter.auto_open_in_new_tab}
                    onchange={() => handleFilterInput(filter)}
                  />
                </div>
                <label for="priorityTelegramToggle-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Telegram</label>
                <div class="flex items-center gap-2">
                  <input
                    id="priorityTelegramToggle-{idx}"
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                    aria-label="Send Telegram notification"
                    bind:checked={filter.telegram_notify}
                    onchange={() => handleFilterInput(filter)}
                    disabled={!tg.enabled || !tgConfigured}
                  />
                  {#if !tg.enabled || !tgConfigured}
                    <span class="text-[10px] text-base-content/30">Configure Telegram below</span>
                  {/if}
                </div>
                <label for="priorityDesktopNotifyToggle-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Desktop notify</label>
                <div>
                  <input
                    id="priorityDesktopNotifyToggle-{idx}"
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                    aria-label="Send desktop notification"
                    bind:checked={filter.desktop_notify}
                    onchange={() => handleFilterInput(filter)}
                  />
                </div>
                <label for="priorityQuietHoursToggle-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Quiet hours</label>
                <div class="flex items-center gap-2">
                  <input
                    id="priorityQuietHoursToggle-{idx}"
                    type="checkbox"
                    class="toggle toggle-primary toggle-xs"
                    aria-label="Enable quiet hours"
                    bind:checked={filter.quiet_hours_enabled}
                    onchange={() => handleFilterInput(filter)}
                  />
                  {#if filter.quiet_hours_enabled}
                    <input
                      type="time"
                      class="input input-xs w-[5.5rem] tabular-nums"
                      aria-label="Quiet hours start"
                      bind:value={filter.quiet_hours_start}
                      onchange={() => handleFilterInput(filter)}
                    />
                    <span class="text-[11px] text-base-content/40">–</span>
                    <input
                      type="time"
                      class="input input-xs w-[5.5rem] tabular-nums"
                      aria-label="Quiet hours end"
                      bind:value={filter.quiet_hours_end}
                      onchange={() => handleFilterInput(filter)}
                    />
                  {/if}
                </div>
                <label for="priorityAlertSoundTypeSelect-{idx}" class="text-[12.5px] text-base-content/50 font-medium">Alert sound</label>
                <div class="flex items-center gap-2">
                  <select
                    id="priorityAlertSoundTypeSelect-{idx}"
                    class="select select-xs w-auto min-w-0"
                    bind:value={filter.alert_sound_type}
                    onchange={() => handleSoundControlChange(filter)}
                  >
                    {#each soundTypeOptions as opt (opt.value)}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                  {#if filter.alert_sound_type !== SOUND_TYPE_NONE}
                    <button
                      class="btn btn-ghost btn-xs w-7 h-7 min-h-0 p-0 text-[11px] flex-shrink-0 bg-base-content/8"
                      type="button"
                      aria-label={isPreviewPlaying ? 'Stop preview' : 'Preview sound'}
                      title={filter.alert_sound_volume <= 0 ? 'Volume is 0' : isPreviewPlaying ? 'Stop' : 'Preview'}
                      disabled={previewDisabled}
                      onclick={() => handlePreviewClick(filter)}
                    >{isPreviewPlaying ? '\u25A0' : '\u25B6'}</button>
                    <input
                      id="priorityAlertSoundVolumeInput-{idx}"
                      type="range"
                      class="range range-primary range-xs flex-1 min-w-0"
                      min={MIN_PRIORITY_ALERT_SOUND_VOLUME}
                      max={MAX_PRIORITY_ALERT_SOUND_VOLUME}
                      step="1"
                      bind:value={filter.alert_sound_volume}
                      oninput={() => handleSoundControlChange(filter)}
                    />
                  {/if}
                </div>
              </div>

              <div class="border-t border-base-300 pt-2 -mx-3 px-3">
                <button
                  class="btn btn-ghost btn-xs text-[11px] w-full justify-start gap-1.5 h-auto py-1 font-normal"
                  type="button"
                  onclick={() => { previewExpandedFilterId = isPreviewExpanded ? '' : filter.id; }}
                >
                  <span class="text-base-content/40">{isPreviewExpanded ? '▾' : '▸'}</span>
                  <span class="tabular-nums font-medium {previewMatches.length > 0 ? 'text-primary' : 'text-base-content/50'}">
                    {previewMatches.length} of {liveStudies.length} live studies match
                  </span>
                </button>
                {#if isPreviewExpanded && previewMatches.length > 0}
                  <div class="mt-1 mb-1 flex flex-col gap-0.5 max-h-[180px] overflow-y-auto">
                    {#each previewMatches as study (study.id)}
                      {@const reward = studyRewardMajor(study)}
                      {@const hourly = studyHourlyRewardMajor(study)}
                      {@const mins = studyEstimatedMinutes(study)}
                      <div class="flex items-baseline gap-1.5 text-[11px] px-1 py-0.5 rounded hover:bg-base-200/50">
                        <span class="text-base-content/70 truncate flex-1 min-w-0" title={study.name}>{study.name}</span>
                        <span class="text-base-content/50 tabular-nums flex-shrink-0">
                          {#if Number.isFinite(reward)}£{reward.toFixed(2)}{/if}
                          {#if Number.isFinite(hourly)}<span class="text-base-content/30">·</span> £{hourly.toFixed(2)}/hr{/if}
                          {#if Number.isFinite(mins)}<span class="text-base-content/30">·</span> {Math.round(mins)}m{/if}
                        </span>
                      </div>
                    {/each}
                  </div>
                {:else if isPreviewExpanded && liveStudies.length === 0}
                  <div class="text-[11px] text-base-content/30 px-1 py-1">No live studies right now. Open Prolific to start seeing matches.</div>
                {:else if isPreviewExpanded}
                  <div class="text-[11px] text-base-content/30 px-1 py-1">No live studies match this filter. Try relaxing your criteria.</div>
                {/if}
              </div>
            </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    <!-- Telegram notifications card -->
    <div class="setting-card bg-base-100 shadow-sm border border-base-300 rounded-lg p-4 mb-2.5">
      <div class="flex items-center justify-between gap-2.5 mb-0.5">
        <div class="text-sm font-semibold text-base-content">Telegram notifications</div>
        <input
          id="telegramEnabledToggle"
          type="checkbox"
          class="toggle toggle-primary toggle-sm"
          aria-label="Enable Telegram notifications"
          bind:checked={tg.enabled}
          onchange={debounceTelegramSave}
          disabled={!tgConfigured}
        />
      </div>
      <div class="text-xs text-base-content/50 leading-snug mb-2">Get notified on Telegram when studies match your filters.</div>

      <button
        class="btn btn-ghost btn-xs text-xs text-base-content/50 p-0 mb-1"
        type="button"
        onclick={() => tgExpanded = !tgExpanded}
      >
        <span class="inline-block transition-transform text-[9px]" class:rotate-90={tgExpanded}>&#9654;</span>
        {tgExpanded ? 'Hide settings' : 'Show settings'}
      </button>

      {#if tgExpanded}
      <div class="flex flex-col gap-2 mt-1">
        <div class="grid grid-cols-[90px_1fr] items-center gap-x-2 gap-y-1.5">
          <label for="tgBotTokenInput" class="text-[12.5px] text-base-content/50 font-medium">Bot token</label>
          <input
            id="tgBotTokenInput"
            type="password"
            class="input input-xs w-full font-mono text-[11px]"
            spellcheck="false"
            autocomplete="off"
            placeholder="123456789:ABCdefGHIjklmno..."
            bind:value={tg.bot_token}
            oninput={handleBotTokenInput}
          />
          <label for="tgChatIdInput" class="text-[12.5px] text-base-content/50 font-medium">Chat ID</label>
          <input
            id="tgChatIdInput"
            type="text"
            class="input input-xs w-full font-mono text-[11px]"
            spellcheck="false"
            autocomplete="off"
            placeholder="987654321"
            bind:value={tg.chat_id}
            oninput={debounceTelegramSave}
          />
        </div>

        <div class="text-xs text-base-content/50 leading-snug mt-1">
          Create a bot via <span class="font-semibold">@BotFather</span>, open your bot and tap <span class="font-semibold">Start</span>, then message <span class="font-semibold">@userinfobot</span> to get your chat ID.
        </div>

        {#if tgBotStatus === 'verifying'}
          <div class="text-[10px] text-base-content/40 mt-1">Verifying bot…</div>
        {:else if tgBotStatus === 'valid' && tgBotName}
          <div class="text-[10px] text-success mt-1 font-medium">Connected to {tgBotName}</div>
        {:else if tgBotStatus === 'invalid'}
          <div class="text-[10px] text-error mt-1">{tgBotError}</div>
        {/if}


        <div class="flex items-center gap-2 mt-0.5">
          <button
            id="tgTestButton"
            class="btn btn-outline btn-xs {tgTestStatus === 'success' ? 'btn-success' : tgTestStatus === 'error' ? 'btn-error' : ''}"
            type="button"
            disabled={!tgConfigured || tgTestStatus === 'sending'}
            onclick={handleTgTestClick}
          >
            {#if tgTestStatus === 'sending'}
              Sending…
            {:else if tgTestStatus === 'success'}
              Sent ✓
            {:else if tgTestStatus === 'error'}
              Failed
            {:else}
              Send test preview
            {/if}
          </button>
          {#if tgTestStatus === 'error' && tgTestError}
            <span class="text-[10px] text-error truncate max-w-[260px]" title={tgTestError}>{tgTestError}</span>
          {/if}
        </div>


        <div class="flex items-center justify-between gap-2 mt-1 pt-2 border-t border-base-300">
          <div>
            <div class="text-[12.5px] text-base-content/70 font-medium">Notify for all new studies</div>
            <div class="text-[10px] text-base-content/40 leading-snug">Send a Telegram message for every newly detected study, regardless of filters.</div>
          </div>
          <input
            id="tgNotifyAllToggle"
            type="checkbox"
            class="toggle toggle-primary toggle-xs flex-shrink-0"
            aria-label="Notify for all studies"
            bind:checked={tg.notify_all_studies}
            onchange={debounceTelegramSave}
          />
        </div>


        <div class="flex items-center justify-between gap-2 mt-1.5">
          <div>
            <div class="text-[12.5px] text-base-content/70 font-medium">Silent notifications</div>
            <div class="text-[10px] text-base-content/40 leading-snug">Deliver without sound or vibration on your device.</div>
          </div>
          <input
            id="tgSilentToggle"
            type="checkbox"
            class="toggle toggle-primary toggle-xs flex-shrink-0"
            aria-label="Silent Telegram notifications"
            bind:checked={tg.silent_notifications}
            onchange={debounceTelegramSave}
          />
        </div>


        <div class="mt-1 pt-2 border-t border-base-300">
          <div class="text-[12.5px] text-base-content/70 font-medium mb-1.5">Message includes</div>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1">
            {#each tgFormatOptions as opt (opt.key)}
              <label class="flex items-center gap-1.5 text-[11px] text-base-content/60 cursor-pointer">
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs checkbox-primary"
                  checked={tg.message_format[opt.key]}
                  onchange={(e: Event) => { tg.message_format[opt.key] = (e.target as HTMLInputElement).checked; debounceTelegramSave(); }}
                /> {opt.label}
              </label>
            {/each}
          </div>
        </div>
      </div>
      {/if}
    </div>

    <!-- Refresh cadence card -->
    <div class="setting-card bg-base-100 shadow-sm border border-base-300 rounded-lg p-4 mb-2.5">
      <div class="text-sm font-semibold text-base-content">Studies refresh rate</div>
      <div class="text-xs text-base-content/50 mt-0.5 leading-snug">Plan delayed backend refreshes inside each 2-minute Prolific auto-refresh cycle.</div>

      <div class="mt-2 flex flex-col gap-2">
        <div class="refresh-field grid grid-cols-[132px_1fr_auto] items-center gap-2">
          <label for="refreshMinDelayInput" class="text-[12.5px] text-base-content/50 font-medium">Minimum delay (s)</label>
          <input id="refreshMinDelayInput" type="range" class="range range-primary range-xs w-full" min="5" max={localRefreshPolicy.maximum_minimum_delay_seconds} step="1" bind:value={localMinDelay} oninput={handleRefreshSliderInput} />
          <span id="refreshMinDelayValue" class="text-[11px] text-base-content font-extrabold font-mono text-right min-w-[34px]">{localMinDelay}s</span>
        </div>
        <div class="refresh-field grid grid-cols-[132px_1fr_auto] items-center gap-2">
          <label for="refreshAverageDelayInput" class="text-[12.5px] text-base-content/50 font-medium">Average delay (s)</label>
          <input id="refreshAverageDelayInput" type="range" class="range range-primary range-xs w-full" min="25" max="60" step="1" bind:value={localAvgDelay} oninput={handleRefreshSliderInput} />
          <span id="refreshAverageDelayValue" class="text-[11px] text-base-content font-extrabold font-mono text-right min-w-[34px]">{localAvgDelay}s</span>
        </div>
        <div class="refresh-field grid grid-cols-[132px_1fr_auto] items-center gap-2">
          <label for="refreshSpreadInput" class="text-[12.5px] text-base-content/50 font-medium">Spread (s)</label>
          <input id="refreshSpreadInput" type="range" class="range range-primary range-xs w-full" min="0" max={localRefreshPolicy.maximum_spread_seconds} step="1" bind:value={localSpread} oninput={handleRefreshSliderInput} />
          <span id="refreshSpreadValue" class="text-[11px] text-base-content font-extrabold font-mono text-right min-w-[34px]">{localSpread}s</span>
        </div>
      </div>

      <!-- Plan summary -->
      <div id="refreshPlanSummary" class="mt-2 text-[10px] text-base-content/60 font-semibold leading-snug">
        {refreshPlanSummary}
      </div>

      <!-- Plan track visualization -->
      <div id="refreshPlanTrack" class="refresh-plan-track mt-2 border border-base-300 rounded-md bg-base-200 dark:bg-base-300/30 h-[44px] relative overflow-hidden">
        <!-- Boundary markers -->
        <span class="refresh-marker boundary absolute top-[6px] h-[22px] w-0.5 rounded-sm bg-success" style="left:0%"></span>
        <span class="refresh-marker boundary absolute top-[6px] h-[22px] w-0.5 rounded-sm bg-success" style="left:100%"></span>

        <!-- Min delay exclusion zones -->
        <span class="refresh-min-window absolute top-[8px] h-[18px] rounded-sm bg-error/20 border border-error/30" style="left:0%;width:{trackPct(localRefreshPolicy.minimum_delay_seconds)}%"></span>
        <span class="refresh-min-window absolute top-[8px] h-[18px] rounded-sm bg-error/20 border border-error/30" style="left:{trackPct(localRefreshPolicy.cycle_seconds - localRefreshPolicy.minimum_delay_seconds)}%;width:{Math.max(0, 100 - trackPct(localRefreshPolicy.cycle_seconds - localRefreshPolicy.minimum_delay_seconds))}%"></span>

        <!-- Min delay exclusion around each marker -->
        {#each refreshPlan.delays as seconds, i (i)}
          {@const left = trackPct(seconds - localRefreshPolicy.minimum_delay_seconds)}
          {@const right = trackPct(seconds + localRefreshPolicy.minimum_delay_seconds)}
          <span class="refresh-min-window absolute top-[8px] h-[18px] rounded-sm bg-error/20 border border-error/30" style="left:{left}%;width:{Math.max(0, right - left)}%"></span>
        {/each}

        <!-- Spread windows -->
        {#each refreshPlan.windows as window, i (i)}
          {@const left = trackPct(window.left)}
          {@const right = trackPct(window.right)}
          <span class="refresh-window absolute top-[8px] h-[18px] rounded-sm bg-base-content/20 border border-base-content/30" style="left:{left}%;width:{Math.max(0, right - left)}%"></span>
        {/each}

        <!-- Service markers -->
        {#each refreshPlan.delays as seconds, i (i)}
          <span class="refresh-marker service absolute top-[8px] h-[18px] w-0.5 rounded-sm bg-base-content" style="left:{trackPct(seconds)}%" title="Extra refresh at ~{Math.round(seconds)}s"></span>
        {/each}

        <!-- Track labels -->
        <span class="absolute bottom-[3px] left-1.5 text-[9px] text-base-content/50 font-mono uppercase tracking-wide font-bold">tab refresh</span>
        <span class="absolute bottom-[3px] right-1.5 text-[9px] text-base-content/50 font-mono uppercase tracking-wide font-bold text-right">+{localRefreshPolicy.cycle_seconds}s</span>
      </div>

      <!-- Save/Revert buttons -->
      <div use:refreshCardActions id="refreshCadenceActions" class="setting-actions mt-2 gap-2" class:flex={hasUnsavedRefreshChanges} class:hidden={!hasUnsavedRefreshChanges}>
        <button
          id="refreshCadenceSaveButton"
          class="btn btn-primary btn-sm flex-1"
          type="button"
          onclick={handleRefreshSave}
        >Save</button>
        <button
          id="refreshCadenceRevertButton"
          class="btn btn-outline btn-sm btn-error flex-1"
          type="button"
          onclick={handleRefreshRevert}
        >Revert</button>
      </div>
    </div>

    <!-- Diagnostics collapsible -->
    <details class="debug-details border border-base-300 rounded-lg bg-base-100 shadow-sm">
      <summary class="debug-summary cursor-pointer text-[13px] font-semibold text-base-content/70 p-3 select-none list-none hover:text-base-content transition-colors">
        <span class="debug-arrow mr-1 text-[10px] text-base-content/40 inline-block">&#9654;</span>Diagnostics
      </summary>
      <div class="debug-card border-t border-base-300 p-3">
        <div class="flex items-center justify-between gap-2.5 mb-2">
          <div class="text-xs font-bold text-base-content">Diagnostics</div>
          <div class="flex items-center gap-1.5">
            <button
              id="refreshDebugButton"
              class="btn btn-ghost btn-xs text-xs font-semibold"
              type="button"
              onclick={onRefreshDebug}
            >Refresh</button>
            <button
              id="clearDebugButton"
              class="btn btn-ghost btn-xs text-xs font-semibold"
              type="button"
              onclick={onClearDebugLogs}
            >Clear Log</button>
          </div>
        </div>

        <div id="debugGrid" class="debug-grid grid grid-cols-2 gap-x-2 gap-y-1.5 text-[11px] mb-2">
          {#each debugRows as [key, value] (key)}
            <div class="debug-row flex items-baseline justify-between gap-2 border-b border-dotted border-base-300 pb-0.5">
              <span class="debug-key text-base-content/50 overflow-hidden text-ellipsis whitespace-nowrap">{key}</span>
              <span class="debug-value text-base-content font-bold whitespace-nowrap overflow-hidden text-ellipsis max-w-[62%] text-right">{value}</span>
            </div>
          {/each}
        </div>

        <div id="debugLog" class="debug-log max-h-[180px] scroll-container border border-base-300 rounded-md bg-base-100/80 p-2 font-mono text-[10px] leading-snug text-base-content/70">
          {#if !debugLogs.length}
            <div class="debug-line">No diagnostic events yet.</div>
          {:else}
            {#each debugLogs as log, i (i)}
              <div class="debug-line mb-1 whitespace-pre-wrap break-words">{log.at}  {log.label}{log.suffix}</div>
            {/each}
          {/if}
        </div>
      </div>
    </details>
  </div>
</div>

<style>
  .panel {
    display: none;
  }
  .panel.active {
    display: block;
  }
  .filter-arrow {
    transition: transform 120ms ease;
  }
  .filter-card {
    transition: opacity 150ms ease, border-color 150ms ease;
  }
  .debug-summary::-webkit-details-marker {
    display: none;
  }
  details[open] .debug-summary {
    border-bottom: 1px solid oklch(var(--bc) / 0.15);
  }
  .debug-arrow {
    transition: transform 120ms ease;
  }
  details[open] .debug-arrow {
    transform: rotate(90deg);
    display: inline-block;
  }
</style>
