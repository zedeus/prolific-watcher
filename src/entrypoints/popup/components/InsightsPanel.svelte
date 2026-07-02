<script lang="ts">
  import type { StudyHistoryInsights, PriceChange } from '../../../lib/study-history';
  import { INSIGHTS_SECTION_LIMIT } from '../../../lib/constants';
  import {
    formatDurationSeconds,
    formatMoneyFromMinorUnits,
    formatRelative,
    studyUrlFromId,
    compactText,
  } from '../../../lib/format';

  interface Props {
    active: boolean;
    insights: StudyHistoryInsights | null;
    /** True when the last load attempt failed (distinguishes "loading" from "couldn't load"). */
    error?: boolean;
    overrideMessage: string;
    onStudyClick?: (url: string) => void;
  }

  let { active, insights, error = false, overrideMessage, onStudyClick }: Props = $props();

  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function hourLabel(h: number): string {
    const hour12 = ((h + 11) % 12) + 1;
    return `${hour12}${h < 12 ? 'am' : 'pm'}`;
  }

  function money(minor: number, currency: string): string {
    return formatMoneyFromMinorUnits({ amount: minor, currency });
  }

  function pctLabel(pct: number): string {
    const rounded = Math.round(pct * 100);
    return `${rounded > 0 ? '+' : ''}${rounded}%`;
  }

  function openStudy(id: string) {
    onStudyClick?.(studyUrlFromId(id));
  }

  const priceShown = $derived((insights?.price_changes ?? []).slice(0, INSIGHTS_SECTION_LIMIT));
  const rerunsShown = $derived((insights?.reruns ?? []).slice(0, INSIGHTS_SECTION_LIMIT));
  const fastest = $derived(insights?.fastest_filling ?? []);

  // Posting-cadence bars scaled to the busiest hour.
  const hourBars = $derived.by(() => {
    const by = insights?.posting.by_hour ?? [];
    const max = by.reduce((m, b) => Math.max(m, b.count), 0);
    return by.map((b) => ({ hour: b.hour, count: b.count, pct: max > 0 ? b.count / max : 0 }));
  });

  function dirClass(c: PriceChange): string {
    return c.direction === 'up' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400';
  }

  // A rerun is frequently overdue (last appeared longer ago than its usual gap) — show "due now"
  // rather than a nonsensical past-tense "next ~2 hours ago".
  function nextLabel(nextAt: string): string {
    const t = new Date(nextAt).getTime();
    if (Number.isFinite(t) && t <= Date.now()) return 'due now';
    return `next ~${formatRelative(nextAt)}`;
  }
</script>

<div id="panelInsights" class="panel" class:active role="tabpanel" aria-labelledby="tabInsights">
  {#if overrideMessage}
    <div class="p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100 min-h-[350px] flex items-center justify-center">
      {overrideMessage}
    </div>
  {:else if error && !insights}
    <div class="p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100 min-h-[350px] flex items-center justify-center">
      Couldn't read your study history. Reopen the popup to try again.
    </div>
  {:else if !insights}
    <div class="p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100 min-h-[350px] flex items-center justify-center">
      <span class="loading loading-spinner loading-sm"></span>
      <span class="ml-2">Reading your study history…</span>
    </div>
  {:else if insights.empty}
    <div class="p-8 text-base-content/50 text-sm text-center border border-dashed border-base-300 rounded-lg bg-base-100 min-h-[350px] flex flex-col items-center justify-center gap-1">
      <span class="text-base-content/70 font-medium">Nothing to show yet</span>
      <span class="max-w-[340px]">As studies come and go, this tab learns their patterns — pay changes, how fast they fill, when they tend to appear, and which ones come back.</span>
    </div>
  {:else}
    <div class="insights min-h-[350px] max-h-[456px] scroll-container pb-1 flex flex-col gap-2">

      <!-- Fill speed + fastest fillers -->
      <section class="rounded-lg border border-base-300 bg-base-100 p-3">
        <div class="flex items-baseline justify-between gap-2">
          <h3 class="text-[13px] font-semibold text-base-content">How fast studies fill</h3>
          <span class="text-[10.5px] text-base-content/45" title="Studies we watched open and later close">{insights.fill_speed.sample} closed</span>
        </div>
        {#if insights.fill_speed.median_seconds !== null}
          <p class="mt-1 text-[12px] text-base-content/70">
            Typically gone in
            <span class="font-semibold text-base-content">{formatDurationSeconds(insights.fill_speed.median_seconds)}</span>
            {#if insights.fill_speed.p25_seconds !== null && insights.fill_speed.p75_seconds !== null}
              <span class="text-base-content/45">
                · most last {formatDurationSeconds(insights.fill_speed.p25_seconds)}–{formatDurationSeconds(insights.fill_speed.p75_seconds)}
              </span>
            {/if}
          </p>
          {#if fastest.length > 0}
            <div class="mt-2 flex flex-col gap-1">
              <span class="text-[10.5px] uppercase tracking-wide text-base-content/40">Filled fastest</span>
              {#each fastest as f (f.study_id)}
                <button
                  type="button"
                  class="flex items-center justify-between gap-2 text-left rounded px-1 -mx-1 py-0.5 hover:bg-base-200/60 cursor-pointer"
                  title="Open {f.study_name}"
                  onclick={() => openStudy(f.study_id)}
                >
                  <span class="min-w-0 truncate text-[12px] text-base-content/80">{compactText(f.study_name, 44)}</span>
                  <span class="shrink-0 text-[11.5px] font-medium text-base-content/60">{formatDurationSeconds(f.duration_seconds)}</span>
                </button>
              {/each}
            </div>
          {/if}
        {:else}
          <p class="mt-1 text-[12px] text-base-content/45">No studies have opened and closed yet — this fills in as studies come and go.</p>
        {/if}
      </section>

      <!-- Pay changes -->
      {#if priceShown.length > 0}
        <section class="rounded-lg border border-base-300 bg-base-100 p-3">
          <div class="flex items-baseline justify-between gap-2">
            <h3 class="text-[13px] font-semibold text-base-content">Pay changes</h3>
            <span class="text-[10.5px] text-base-content/45" title="Studies whose reward went up or down">{insights.price_changes.length} spotted</span>
          </div>
          <div class="mt-2 flex flex-col gap-1.5">
            {#each priceShown as c (c.study_id)}
              <button
                type="button"
                class="flex items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 hover:bg-base-200/60 cursor-pointer"
                title="Open {c.study_name}"
                onclick={() => openStudy(c.study_id)}
              >
                <span class="shrink-0 text-[13px] leading-none {dirClass(c)}">{c.direction === 'up' ? '▲' : '▼'}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-[12px] text-base-content/85">{compactText(c.study_name, 40)}</span>
                  {#if c.researcher_name}<span class="block truncate text-[10.5px] text-base-content/45">{c.researcher_name}</span>{/if}
                </span>
                <span class="shrink-0 text-right">
                  <span class="block text-[11.5px] text-base-content/70">
                    {money(c.first_reward_minor, c.currency)} → <span class="font-semibold {dirClass(c)}">{money(c.last_reward_minor, c.currency)}</span>
                  </span>
                  <span class="block text-[10.5px] {dirClass(c)}">{pctLabel(c.pct)} · {formatRelative(c.changed_at)}</span>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Best times -->
      {#if insights.posting.total_postings > 0}
        <section class="rounded-lg border border-base-300 bg-base-100 p-3">
          <div class="flex items-baseline justify-between gap-2">
            <h3 class="text-[13px] font-semibold text-base-content">When new studies appear</h3>
            <span class="text-[10.5px] text-base-content/45" title="Times a study became available">{insights.posting.total_postings} seen</span>
          </div>
          {#if insights.posting.peak_hour !== null}
            <p class="mt-0.5 text-[11.5px] text-base-content/60">
              Busiest around <span class="font-semibold text-base-content/80">{hourLabel(insights.posting.peak_hour)}</span>{#if insights.posting.peak_dow !== null}, mostly <span class="font-semibold text-base-content/80">{DOW[insights.posting.peak_dow]}</span>{/if} <span class="text-base-content/40">(your local time)</span>
            </p>
          {/if}
          <div class="mt-2 flex items-end gap-[2px] h-[52px]" aria-hidden="true">
            {#each hourBars as b (b.hour)}
              <div
                class="flex-1 rounded-t-sm {b.hour === insights.posting.peak_hour ? 'bg-primary' : 'bg-primary/30'}"
                style:height={`${Math.max(b.pct * 100, b.count > 0 ? 6 : 2)}%`}
                title="{hourLabel(b.hour)}: {b.count}"
              ></div>
            {/each}
          </div>
          <div class="mt-1 flex justify-between text-[9.5px] text-base-content/35">
            <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
          </div>
        </section>
      {/if}

      <!-- Reruns -->
      {#if rerunsShown.length > 0}
        <section class="rounded-lg border border-base-300 bg-base-100 p-3">
          <div class="flex items-baseline justify-between gap-2">
            <h3 class="text-[13px] font-semibold text-base-content">Studies that come back</h3>
            <span class="text-[10.5px] text-base-content/45" title="Studies re-listed after closing">{insights.reruns.length} recurring</span>
          </div>
          <div class="mt-2 flex flex-col gap-1.5">
            {#each rerunsShown as r (r.study_id)}
              <button
                type="button"
                class="flex items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 hover:bg-base-200/60 cursor-pointer"
                title="Open {r.study_name}"
                onclick={() => openStudy(r.study_id)}
              >
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="truncate text-[12px] text-base-content/85">{compactText(r.study_name, 36)}</span>
                    {#if r.regular}<span class="shrink-0 badge badge-xs badge-ghost text-[9px]">scheduled</span>{/if}
                  </span>
                  {#if r.researcher_name}<span class="block truncate text-[10.5px] text-base-content/45">{r.researcher_name}</span>{/if}
                </span>
                <span class="shrink-0 text-right">
                  <span class="block text-[11.5px] text-base-content/70">every ~{formatDurationSeconds(r.median_gap_seconds)}</span>
                  <span class="block text-[10.5px] text-base-content/45">seen {r.appearances}× · {nextLabel(r.next_expected_at)}</span>
                </span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

    </div>
  {/if}
</div>

<style>
  .panel {
    display: none;
  }
  .panel.active {
    display: block;
  }
</style>
