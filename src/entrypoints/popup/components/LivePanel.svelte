<script lang="ts">
  import type { Study, PriorityFilter, TelegramSettings, FilterListField } from '../../../lib/types';
  import { reliabilityFor, type ResearcherProfile } from '../../../lib/researcher-profile';
  import {
    formatMoneyFromMinorUnits,
    moneyMajorValue,
    formatDurationMinutes,
    formatShortNumber,
    formatRelative,
    parseDate,
    studyUrlFromId,
    rateColorClass,
    formatStudyLabel,
    getCurrencySymbol,
  } from '../../../lib/format';
  import {
    studyMatchesPriorityFilter,
    studyKeywordBlob,
    studyRewardMajor,
    studyHourlyRewardMajor,
    studyEstimatedMinutes,
    studyPlacesAvailable,
  } from '../../background/domain';
  import StudyActionMenu from './StudyActionMenu.svelte';
  import StudyTitle from './StudyTitle.svelte';
  import { isTargetMuted, type MuteEntry, type MuteDuration } from '../../../lib/mutes';

  let {
    active,
    loading = false,
    studies,
    priorityFilters,
    telegramSettings,
    primaryCurrency,
    overrideMessage,
    onStudyClick,
    onAddResearcherToFilter,
    onAddResearcherToNewFilter,
    onCopyLink,
    onSendStudyToTelegram,
    onViewResearcher,
    researcherProfiles,
    mutes = [],
    nowMS = Date.now(),
    onMuteStudy,
    onMuteResearcher,
    onUnmuteStudy,
    onUnmuteResearcher,
  } = $props<{
    active: boolean;
    loading?: boolean;
    studies: Study[];
    priorityFilters: PriorityFilter[];
    telegramSettings: TelegramSettings;
    researcherProfiles?: Map<string, ResearcherProfile>;
    primaryCurrency: string;
    overrideMessage: string;
    onStudyClick: (url: string) => void;
    onAddResearcherToFilter: (study: Study, filterId: string, field: FilterListField) => void;
    onAddResearcherToNewFilter: (study: Study, field: FilterListField) => void;
    onCopyLink: (url: string) => void;
    onSendStudyToTelegram: (study: Study) => void;
    onViewResearcher?: (researcherId: string, researcherName: string) => void;
    mutes?: MuteEntry[];
    /** Shared coarse clock (ms) from App so mute badges lapse without a per-panel timer. */
    nowMS?: number;
    onMuteStudy?: (study: Study, duration: MuteDuration) => void;
    onMuteResearcher?: (study: Study, duration: MuteDuration) => void;
    onUnmuteStudy?: (study: Study) => void;
    onUnmuteResearcher?: (study: Study) => void;
  }>();

  function studyDirectlyMuted(study: Study): boolean {
    return isTargetMuted('study', study?.id?.trim() || '', mutes, nowMS);
  }
  function researcherMutedNow(study: Study): boolean {
    return isTargetMuted('researcher', study?.researcher?.id?.trim() || '', mutes, nowMS);
  }

  type SortKey = 'newest' | 'reward' | 'hourly' | 'places' | 'duration' | 'reliability';

  let sortKey = $state<SortKey>('newest');
  let searchQuery = $state('');
  let minReward = $state<number | null>(null);
  let minHourly = $state<number | null>(null);
  let maxDuration = $state<number | null>(null);
  let hidePoorResearchers = $state(false);

  function studyReliability(study: Study) {
    return reliabilityFor(researcherProfiles, study?.researcher?.id?.trim());
  }
  /** Reliability score for sorting; NaN (→ sorts last) when the researcher has no rated history. */
  function studyReliabilityScore(study: Study): number {
    const rel = studyReliability(study);
    return rel?.hasEnoughData ? rel.score : NaN;
  }

  const enabledFilters = $derived(priorityFilters.filter((f: PriorityFilter) => f.enabled));

  function getTimestamp(study: Study): number {
    const date = parseDate(study.published_at || study.date_created);
    return date ? date.getTime() : 0;
  }

  let filtersExpanded = $state(false);

  const hasNumericFilters = $derived(
    (minReward !== null && minReward > 0) ||
    (minHourly !== null && minHourly > 0) ||
    (maxDuration !== null && maxDuration > 0)
  );

  const hasQuickFilters = $derived(hasNumericFilters || hidePoorResearchers);
  const hasActiveFilters = $derived(searchQuery.trim() !== '' || hasQuickFilters);

  const currencySymbol = $derived(getCurrencySymbol(primaryCurrency));

  const filteredAndSortedStudies = $derived.by(() => {
    let result = [...studies];
    const query = searchQuery.trim().toLowerCase();

    if (query) {
      result = result.filter((s) => {
        const blob = studyKeywordBlob(s);
        const researcher = s.researcher?.name?.toLowerCase() || '';
        return blob.includes(query) || researcher.includes(query);
      });
    }

    if (minReward !== null && minReward > 0) {
      const threshold = minReward;
      result = result.filter((s) => studyRewardMajor(s) >= threshold);
    }
    if (minHourly !== null && minHourly > 0) {
      const threshold = minHourly;
      result = result.filter((s) => studyHourlyRewardMajor(s) >= threshold);
    }
    if (maxDuration !== null && maxDuration > 0) {
      const threshold = maxDuration;
      result = result.filter((s) => {
        const d = studyEstimatedMinutes(s);
        return Number.isFinite(d) && d <= threshold;
      });
    }
    if (hidePoorResearchers) {
      // Only hide researchers we've actually rated as poor — never penalise unknowns.
      result = result.filter((s) => studyReliability(s)?.band !== 'poor');
    }

    result.sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortKey) {
        case 'reward':
          aVal = studyRewardMajor(a);
          bVal = studyRewardMajor(b);
          break;
        case 'hourly':
          aVal = studyHourlyRewardMajor(a);
          bVal = studyHourlyRewardMajor(b);
          break;
        case 'places':
          aVal = studyPlacesAvailable(a);
          bVal = studyPlacesAvailable(b);
          break;
        case 'duration':
          aVal = studyEstimatedMinutes(a);
          bVal = studyEstimatedMinutes(b);
          break;
        case 'reliability':
          aVal = studyReliabilityScore(a);
          bVal = studyReliabilityScore(b);
          break;
        case 'newest':
        default:
          aVal = getTimestamp(a);
          bVal = getTimestamp(b);
          break;
      }
      const aFinite = Number.isFinite(aVal);
      const bFinite = Number.isFinite(bVal);
      if (aFinite && bFinite) {
        const diff = sortKey === 'duration' ? aVal - bVal : bVal - aVal;
        if (diff !== 0) return diff;
      } else if (aFinite !== bFinite) {
        return aFinite ? -1 : 1;
      }
      return (a.id || '').localeCompare(b.id || '');
    });

    return result;
  });

  function clearFilters() {
    searchQuery = '';
    minReward = null;
    minHourly = null;
    maxDuration = null;
    hidePoorResearchers = false;
  }

  function handleLinkClick(event: MouseEvent, url: string) {
    event.preventDefault();
    onStudyClick(url);
  }
</script>

<div id="panelLive" class="panel" class:active role="tabpanel" aria-labelledby="tabLive">
  {#if !overrideMessage && studies.length > 0}
    <div class="live-toolbar mb-2 space-y-1.5">
      <div class="flex items-center gap-1.5">
        <input
          type="text"
          class="input input-xs flex-1 min-w-0"
          placeholder="Search..."
          bind:value={searchQuery}
        />
        <select
          class="select select-xs w-auto"
          bind:value={sortKey}
          title="Sort studies by"
        >
          <option value="newest">Newest</option>
          <option value="reward">Pay ↓</option>
          <option value="hourly">Rate ↓</option>
          <option value="places">Spots ↓</option>
          <option value="duration">Time ↑</option>
          <option value="reliability">Trust ↓</option>
        </select>
        <button
          type="button"
          class="btn btn-xs btn-square {filtersExpanded || hasQuickFilters ? 'btn-primary' : 'btn-ghost'}"
          class:btn-outline={hasQuickFilters && !filtersExpanded}
          onclick={() => filtersExpanded = !filtersExpanded}
          title="Quick filters"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </button>
      </div>
      {#if filtersExpanded}
        <div class="flex items-center gap-3 px-1 py-1.5 bg-base-200/50 rounded-lg text-[11px]">
          <label class="flex items-center gap-1 text-base-content/70" title="Minimum reward">
            <span class="text-[12px] font-semibold text-base-content/60">{currencySymbol}</span>
            <input
              type="number"
              class="input input-xs w-12 tabular-nums text-center bg-base-100"
              min="0"
              step="0.5"
              placeholder="any"
              bind:value={minReward}
            />
          </label>
          <label class="flex items-center gap-1 text-base-content/70" title="Minimum hourly rate">
            <span class="text-[12px] font-semibold text-base-content/60">{currencySymbol}/hr</span>
            <input
              type="number"
              class="input input-xs w-12 tabular-nums text-center bg-base-100"
              min="0"
              step="1"
              placeholder="any"
              bind:value={minHourly}
            />
          </label>
          <label class="flex items-center gap-1 text-base-content/70" title="Maximum duration in minutes">
            <span class="text-[12px] font-semibold text-base-content/60">ETA</span>
            <input
              type="number"
              class="input input-xs w-12 tabular-nums text-center bg-base-100"
              min="0"
              step="5"
              placeholder="any"
              bind:value={maxDuration}
            />
          </label>
          <label class="flex items-center gap-1 text-base-content/70 cursor-pointer" title="Hide studies from researchers you've rated Poor">
            <input type="checkbox" class="checkbox checkbox-xs" bind:checked={hidePoorResearchers} />
            <span>Hide poor-rated</span>
          </label>
          {#if hasQuickFilters}
            <button
              type="button"
              class="btn btn-ghost btn-xs ml-auto px-2 h-6 min-h-0 text-[11px] text-base-content/50 hover:text-error"
              onclick={clearFilters}
              title="Clear filters"
            >✕ clear</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
  <div class="live-studies min-h-[350px] max-h-[350px] scroll-container pb-1">
    {#if overrideMessage}
      <div class="empty-events p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100">
        {overrideMessage}
      </div>
    {:else if loading && !studies.length}
      {#each [0, 1, 2] as i (i)}
        <div class="p-3.5 rounded-lg mb-2.5 border border-base-300 bg-base-100 animate-pulse">
          <div class="h-4 bg-base-300 rounded w-3/4 mb-3"></div>
          <div class="flex gap-3">
            <div class="h-5 bg-base-300 rounded w-16"></div>
            <div class="h-4 bg-base-300 rounded w-14"></div>
            <div class="h-4 bg-base-300 rounded w-10"></div>
            <div class="h-4 bg-base-300 rounded w-12"></div>
          </div>
        </div>
      {/each}
    {:else if !filteredAndSortedStudies.length}
      <div class="empty-events p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100">
        {#if hasActiveFilters}
          No studies match. Try widening your filters or click Clear.
        {:else}
          No studies available right now. They'll appear here automatically.
        {/if}
      </div>
    {:else}
      {#each filteredAndSortedStudies as study (study.id)}
        {@const blob = enabledFilters.length > 0 ? studyKeywordBlob(study) : ''}
        {@const isPriority = enabledFilters.length > 0 && enabledFilters.some((f: PriorityFilter) => studyMatchesPriorityFilter(study, f, blob))}
        {@const url = studyUrlFromId(study.id)}
        {@const reward = formatMoneyFromMinorUnits(study.reward)}
        {@const perHourAmount = moneyMajorValue(study.average_reward_per_hour)}
        {@const perHour = formatMoneyFromMinorUnits(study.average_reward_per_hour)}
        {@const eta = formatDurationMinutes(study.estimated_completion_time)}
        {@const placesAvailable = Number(study.places_available)}
        {@const placesLabel = Number.isFinite(placesAvailable) ? `${formatShortNumber(placesAvailable)} left` : 'n/a left'}
        {@const placesLow = Number.isFinite(placesAvailable) && placesAvailable <= 5}
        {@const firstSeenText = study.first_seen_at ? formatRelative(study.first_seen_at) : ''}
        {@const hourlyClass = rateColorClass(perHourAmount)}
        {@const studyTypeLabel = formatStudyLabel(study.study_labels, study.ai_inferred_study_labels)}

        {@const researcherName = study.researcher?.name?.trim() || ''}
        {@const researcherMuted = researcherMutedNow(study)}
        {@const studyMuted = studyDirectlyMuted(study)}
        {@const muted = studyMuted || researcherMuted}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
          <a
            class="event-link block no-underline text-inherit rounded-lg outline-none"
            href={url}
            title="Open study in Prolific"
            onclick={(e) => handleLinkClick(e, url)}
          >
            <div class="event live {isPriority ? 'priority' : ''} p-3.5 rounded-lg mb-2.5 text-[12.5px] shadow-sm border border-base-300 bg-base-100 {isPriority ? 'priority-card' : ''}">
              <div class="event-top flex items-start justify-between gap-2.5">
                <div class="event-title text-sm font-semibold leading-snug mr-auto text-base-content line-clamp-2">
                  <StudyTitle
                    name={study.name || '(unnamed study)'}
                    {researcherName}
                    researcherId={study.researcher?.id?.trim() || ''}
                    onResearcherClick={onViewResearcher}
                    reliability={studyReliability(study)}
                  />
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                  {#if firstSeenText}
                    <div class="event-time text-base-content/50 text-xs whitespace-nowrap text-right font-medium">{firstSeenText}</div>
                  {/if}
                  <StudyActionMenu
                    {study}
                    studyUrl={url}
                    {priorityFilters}
                    {telegramSettings}
                    onAddToFilter={(filterId, field) => onAddResearcherToFilter(study, filterId, field)}
                    onAddToNewFilter={(field) => onAddResearcherToNewFilter(study, field)}
                    onCopyLink={() => onCopyLink(url)}
                    onSendTelegram={() => onSendStudyToTelegram(study)}
                    onViewProfile={onViewResearcher}
                    {studyMuted}
                    {researcherMuted}
                    onMuteStudy={(duration) => onMuteStudy?.(study, duration)}
                    onMuteResearcher={(duration) => onMuteResearcher?.(study, duration)}
                    onUnmuteStudy={() => onUnmuteStudy?.(study)}
                    onUnmuteResearcher={() => onUnmuteResearcher?.(study)}
                  />
                </div>
              </div>
              <div class="event-metrics mt-1.5 flex items-baseline gap-x-1.5 flex-wrap gap-y-0.5">
                <span class="text-[15px] font-bold text-primary">{reward}</span>
                <span class="text-[12px] font-semibold {hourlyClass}">{perHour}/hr</span>
                <span class="text-base-content/20 select-none">·</span>
                <span class="text-xs text-base-content/55">{eta}</span>
                <span class="text-base-content/20 select-none">·</span>
                <span class="text-xs {placesLow ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-base-content/55'}">{placesLabel}</span>
                {#if studyTypeLabel}
                  <span class="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-[1px] rounded bg-base-300 text-base-content/60">{studyTypeLabel}</span>
                {/if}
                {#if isPriority}
                  <span class="ml-0.5 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-[1px] rounded bg-purple-700 text-purple-100 dark:bg-purple-500 dark:text-white">priority</span>
                {/if}
                {#if muted}
                  <span
                    class="ml-0.5 text-[9px] font-semibold uppercase tracking-wider px-1.5 py-[1px] rounded bg-base-300 text-base-content/60 inline-flex items-center gap-0.5"
                    title={researcherMuted ? 'Muted — this researcher is snoozed' : 'Muted — no alerts or auto-open'}
                  >&#128277; muted</span>
                {/if}
              </div>
            </div>
          </a>
      {/each}
    {/if}
  </div>
</div>

<style>
  .event {
    transition: transform 100ms ease, box-shadow 100ms ease;
  }
  .priority-card {
    border-left: 3px solid #a855f7;
    background: #faf5ff;
  }
  :global([data-theme="dark"]) .priority-card {
    background: rgba(88, 28, 135, 0.25);
  }
  .event-link:hover .event {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px oklch(var(--bc) / 0.10), 0 1px 3px oklch(var(--bc) / 0.06);
  }
  .event-link:hover .event.priority {
    box-shadow: 0 4px 12px oklch(var(--bc) / 0.10), 0 1px 3px oklch(var(--bc) / 0.06), inset 0 0 0 1px rgba(124, 58, 237, 0.18);
    background: oklch(var(--p) / 0.08);
  }
  .event-link:focus-visible .event {
    box-shadow: 0 4px 12px oklch(var(--bc) / 0.10), 0 1px 3px oklch(var(--bc) / 0.06);
  }
  .event-link:active .event {
    transform: translateY(0);
  }
  .panel {
    display: none;
  }
  .panel.active {
    display: block;
  }
</style>
