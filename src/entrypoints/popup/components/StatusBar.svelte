<script lang="ts">
  import type { PauseDuration } from '../../../lib/pause';
  import { isTransientStatusMessage } from '../../../lib/format';

  let {
    offline,
    errorMessage,
    latestRefreshText,
    latestRefreshTitle,
    refreshPrefix,
    darkMode,
    onToggleDarkMode,
    paused = false,
    pauseRemaining = '',
    onPause,
    onResume,
  } = $props<{
    offline: boolean;
    errorMessage: string;
    latestRefreshText: string;
    latestRefreshTitle: string;
    refreshPrefix: string;
    darkMode: boolean;
    onToggleDarkMode: () => void;
    paused?: boolean;
    pauseRemaining?: string;
    onPause?: (duration: PauseDuration) => void;
    onResume?: () => void;
  }>();

  let pauseMenu: HTMLDetailsElement | null = $state(null);

  const isWarning = $derived(isTransientStatusMessage(errorMessage));

  function pause(duration: PauseDuration) {
    if (pauseMenu) pauseMenu.open = false;
    onPause?.(duration);
  }
</script>

<div class="flex items-center gap-2 px-0.5 pb-2.5">
  <span
    id="syncDot"
    class="inline-block w-2.5 h-2.5 rounded-full flex-none {paused ? 'bg-warning shadow-[0_0_0_2px_rgba(245,158,11,0.15)] paused' : offline && isWarning ? 'bg-warning shadow-[0_0_0_2px_rgba(245,158,11,0.15)]' : offline ? 'bg-error shadow-[0_0_0_2px_rgba(225,29,72,0.15)] bad' : 'bg-success shadow-[0_0_0_2px_rgba(26,147,111,0.15)]'}"
    title="Sync status"
    aria-label={paused ? 'Paused' : offline ? (isWarning ? 'Recovering' : 'Offline') : 'Connected'}
  ></span>
  <span class="whitespace-nowrap font-semibold text-[13px] text-base-content/70">
    {#if paused}
      <span id="latestRefresh">Paused{pauseRemaining ? ` · ${pauseRemaining} left` : ''}</span>
    {:else}
      <span>{refreshPrefix}</span><span id="latestRefresh" title={latestRefreshTitle}>{latestRefreshText}</span>
    {/if}
  </span>

  <div class="ml-auto flex items-center gap-1">
    {#if paused}
      <button
        id="resumeButton"
        type="button"
        class="btn btn-xs btn-warning gap-1 h-6 min-h-0 px-2 text-[11px]"
        title="Resume refreshing, alerts, and auto-open"
        onclick={onResume}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        Resume
      </button>
    {:else}
      <details bind:this={pauseMenu} class="dropdown dropdown-end">
        <summary
          id="pauseButton"
          class="btn btn-ghost btn-xs h-6 min-h-0 px-1.5 text-[11px] text-base-content/50 hover:text-base-content gap-1 list-none"
          title="Pause refreshing, alerts, and auto-open"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
          Pause
        </summary>
        <ul class="dropdown-content menu z-10 mt-1 w-44 rounded-box border border-base-300 bg-base-100 p-1 shadow-xl">
          <li class="menu-title px-2 py-1 text-[10px] uppercase tracking-wider text-base-content/45">Pause everything for…</li>
          <li><button type="button" class="text-[12px]" onclick={() => pause('1h')}>1 hour</button></li>
          <li><button type="button" class="text-[12px]" onclick={() => pause('8h')}>8 hours</button></li>
          <li><button type="button" class="text-[12px]" onclick={() => pause('forever')}>Until I resume</button></li>
        </ul>
      </details>
    {/if}
    <button
      class="text-base-content/50 hover:text-base-content transition-colors duration-100 p-1 -m-1 rounded"
      type="button"
      title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
      onclick={onToggleDarkMode}
    >
      {#if darkMode}
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      {/if}
    </button>
  </div>
</div>

{#if paused}
  <div
    id="pausedBanner"
    class="mb-2.5 flex items-center gap-2 text-[12.5px] leading-snug py-2 px-3.5 rounded-lg border border-warning/40 bg-warning/10 text-base-content"
  >
    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" class="flex-none opacity-70"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
    <span>Paused — no refreshing, alerts, or auto-open{pauseRemaining ? ` · resumes in ${pauseRemaining}` : ''}.</span>
  </div>
{/if}

{#if errorMessage && !paused}
  <div
    id="errorMessage"
    class="mb-2.5 flex items-center gap-2 text-[12.5px] leading-snug py-2 px-3.5 rounded-lg border {isWarning ? 'border-warning/40 bg-warning/10 text-base-content' : 'border-error/30 bg-error/10 text-error-content dark:text-error'}"
  >
    {#if isWarning}
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-none opacity-70"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    {:else}
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="flex-none opacity-70"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    {/if}
    <span>{errorMessage}</span>
  </div>
{:else}
  <div id="errorMessage" class="hidden"></div>
{/if}
