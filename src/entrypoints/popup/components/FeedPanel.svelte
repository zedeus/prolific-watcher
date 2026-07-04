<script lang="ts">
  import type { StudyEvent } from '../../../lib/types';
  import { reliabilityFor, type ResearcherProfile } from '../../../lib/researcher-profile';
  import StudyTitle from './StudyTitle.svelte';
  import {
    formatMoneyFromMinorUnits,
    moneyMajorValue,
    formatDurationMinutes,
    formatShortNumber,
    formatRelative,
    studyUrlFromId,
    rateColorClass,
    parseDate,
    getCurrencySymbol,
  } from '../../../lib/format';

  let { active, loading = false, events, primaryCurrency, overrideMessage, onStudyClick, onViewResearcher, researcherProfiles } = $props<{
    active: boolean;
    loading?: boolean;
    events: StudyEvent[];
    primaryCurrency: string;
    overrideMessage: string;
    onStudyClick: (url: string) => void;
    onViewResearcher?: (researcherId: string, researcherName: string) => void;
    researcherProfiles?: Map<string, ResearcherProfile>;
  }>();

  type SortKey = 'newest' | 'reward' | 'hourly';
  type EventFilter = 'all' | 'available' | 'unavailable';

  let sortKey = $state<SortKey>('newest');
  let searchQuery = $state('');
  let eventFilter = $state<EventFilter>('all');
  let filtersExpanded = $state(false);
  let minReward = $state<number | null>(null);
  let minHourly = $state<number | null>(null);
  let maxDuration = $state<number | null>(null);

  const currencySymbol = $derived(getCurrencySymbol(primaryCurrency));

  const hasNumericFilters = $derived(
    (minReward !== null && minReward > 0) ||
    (minHourly !== null && minHourly > 0) ||
    (maxDuration !== null && maxDuration > 0)
  );

  const hasActiveFilters = $derived(
    searchQuery.trim() !== '' || eventFilter !== 'all' || hasNumericFilters
  );

  const filteredAndSorted = $derived.by(() => {
    let result = [...events];
    const query = searchQuery.trim().toLowerCase();

    if (query) {
      result = result.filter((e) => {
        const name = (e.study_name || '').toLowerCase();
        const researcher = (e.researcher_name || '').toLowerCase();
        return name.includes(query) || researcher.includes(query);
      });
    }

    if (eventFilter !== 'all') {
      result = result.filter((e) => e.event_type === eventFilter);
    }

    if (minReward !== null && minReward > 0) {
      const threshold = minReward;
      result = result.filter((e) => moneyMajorValue(e.reward) >= threshold);
    }
    if (minHourly !== null && minHourly > 0) {
      const threshold = minHourly;
      result = result.filter((e) => moneyMajorValue(e.average_reward_per_hour) >= threshold);
    }
    if (maxDuration !== null && maxDuration > 0) {
      const threshold = maxDuration;
      result = result.filter((e) => {
        const d = Number(e.estimated_completion_time);
        return Number.isFinite(d) && d <= threshold;
      });
    }

    result.sort((a, b) => {
      let aVal: number, bVal: number;
      switch (sortKey) {
        case 'reward':
          aVal = moneyMajorValue(a.reward);
          bVal = moneyMajorValue(b.reward);
          break;
        case 'hourly':
          aVal = moneyMajorValue(a.average_reward_per_hour);
          bVal = moneyMajorValue(b.average_reward_per_hour);
          break;
        case 'newest':
        default: {
          const aDate = parseDate(a.observed_at);
          const bDate = parseDate(b.observed_at);
          aVal = aDate ? aDate.getTime() : 0;
          bVal = bDate ? bDate.getTime() : 0;
          break;
        }
      }
      const aFinite = Number.isFinite(aVal);
      const bFinite = Number.isFinite(bVal);
      if (aFinite && bFinite) {
        const diff = bVal - aVal;
        if (diff !== 0) return diff;
      } else if (aFinite !== bFinite) {
        return aFinite ? -1 : 1;
      }
      return (b.row_id ?? 0) - (a.row_id ?? 0);
    });

    return result;
  });

  function clearFilters() {
    searchQuery = '';
    eventFilter = 'all';
    minReward = null;
    minHourly = null;
    maxDuration = null;
  }

  function handleLinkClick(event: MouseEvent, url: string) {
    event.preventDefault();
    onStudyClick(url);
  }
</script>

<div id="panelFeed" class="panel" class:active role="tabpanel" aria-labelledby="tabFeed">
  {#if !overrideMessage && events.length > 0}
    <div class="feed-toolbar mb-2 space-y-1.5">
      <div class="flex items-center gap-1.5">
        <input
          type="text"
          class="input input-xs flex-1 min-w-0"
          placeholder="Search..."
          bind:value={searchQuery}
        />
        <select
          class="select select-xs w-auto"
          bind:value={eventFilter}
          title="Filter by event type"
        >
          <option value="all">All</option>
          <option value="available">Available</option>
          <option value="unavailable">Filled</option>
        </select>
        <select
          class="select select-xs w-auto"
          bind:value={sortKey}
          title="Sort events by"
        >
          <option value="newest">Newest</option>
          <option value="reward">Pay ↓</option>
          <option value="hourly">Rate ↓</option>
        </select>
        <button
          type="button"
          class="btn btn-xs btn-square {filtersExpanded || hasNumericFilters ? 'btn-primary' : 'btn-ghost'}"
          class:btn-outline={hasNumericFilters && !filtersExpanded}
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
          {#if hasNumericFilters}
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
  <div class="events min-h-[350px] max-h-[350px] scroll-container pb-1">
    {#if overrideMessage}
      <div class="empty-events p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100">
        {overrideMessage}
      </div>
    {:else if loading && !events.length}
      {#each [0, 1, 2] as i (i)}
        <div class="p-3.5 rounded-lg mb-2.5 border border-base-300 bg-base-100 animate-pulse">
          <div class="flex items-start justify-between mb-3">
            <div class="h-4 bg-base-300 rounded w-2/3"></div>
            <div class="h-3 bg-base-300 rounded w-16"></div>
          </div>
          <div class="flex gap-3">
            <div class="h-5 bg-base-300 rounded w-16"></div>
            <div class="h-4 bg-base-300 rounded w-14"></div>
            <div class="h-4 bg-base-300 rounded w-10"></div>
          </div>
        </div>
      {/each}
    {:else if !filteredAndSorted.length}
      <div class="empty-events p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100">
        {#if hasActiveFilters}
          No events match your filters.
        {:else}
          No events recorded yet. Events appear when studies become available or fill up.
        {/if}
      </div>
    {:else}
      {#each filteredAndSorted as evt (evt.row_id)}
        {@const type = evt.event_type === 'available' ? 'available' : 'unavailable'}
        {@const name = evt.study_name || '(unnamed study)'}
        {@const observedAt = formatRelative(evt.observed_at, true)}
        {@const reward = formatMoneyFromMinorUnits(evt.reward)}
        {@const perHourAmount = moneyMajorValue(evt.average_reward_per_hour)}
        {@const perHour = formatMoneyFromMinorUnits(evt.average_reward_per_hour)}
        {@const hourlyClass = rateColorClass(perHourAmount)}
        {@const duration = formatDurationMinutes(evt.estimated_completion_time)}
        {@const totalPlaces = Number(evt.total_available_places)}
        {@const remainingPlaces = Number(evt.places_available)}
        {@const isLowRemaining = type === 'available' && Number.isFinite(remainingPlaces) && remainingPlaces <= 5}
        {@const placesLine = type === 'available'
          ? `${Number.isFinite(remainingPlaces) ? formatShortNumber(remainingPlaces) : 'n/a'} left`
          : `${Number.isFinite(totalPlaces) ? formatShortNumber(totalPlaces) : 'n/a'} total`}
        {@const studyURL = studyUrlFromId(evt.study_id)}

        <!-- svelte-ignore a11y_no_static_element_interactions -->
          <a
            class="event-link block no-underline text-inherit rounded-lg outline-none"
            href={studyURL}
            title="Open study in Prolific"
            onclick={(e) => handleLinkClick(e, studyURL)}
          >
            <div class="event {type} p-3.5 rounded-lg mb-2.5 text-[12.5px] border border-base-300 {type === 'available' ? 'bg-base-100 shadow-sm' : 'bg-base-200/60'} border-l-3 {type === 'available' ? 'border-l-success' : 'border-l-error'}">
              <div class="event-top flex items-start justify-between gap-2.5">
                <div class="event-title text-sm font-semibold leading-snug mr-auto text-base-content line-clamp-2">
                  <StudyTitle
                    {name}
                    researcherName={evt.researcher_name}
                    researcherId={evt.researcher_id}
                    onResearcherClick={onViewResearcher}
                    reliability={reliabilityFor(researcherProfiles, evt.researcher_id)}
                  />
                </div>
                <div class="event-time text-base-content/50 text-xs whitespace-nowrap text-right font-medium">{observedAt}</div>
              </div>
              <div class="event-metrics mt-1.5 flex items-baseline gap-x-1.5 flex-wrap gap-y-0.5">
                <span class="text-[15px] font-bold text-primary">{reward}</span>
                <span class="text-[12px] font-semibold {hourlyClass}">{perHour}/hr</span>
                <span class="text-base-content/20 select-none">·</span>
                <span class="text-xs text-base-content/55">{duration}</span>
                <span class="text-base-content/20 select-none">·</span>
                <span class="text-xs {isLowRemaining ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-base-content/55'}">{placesLine}</span>
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
  .event-link:hover .event {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px oklch(var(--bc) / 0.10), 0 1px 3px oklch(var(--bc) / 0.06);
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
