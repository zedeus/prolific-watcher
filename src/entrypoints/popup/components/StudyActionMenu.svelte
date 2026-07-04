<script lang="ts">
  import { tick } from 'svelte';
  import type { Study, PriorityFilter, TelegramSettings, FilterListField } from '../../../lib/types';
  import type { MuteDuration } from '../../../lib/mutes';

  interface Props {
    study: Study;
    studyUrl: string;
    priorityFilters: PriorityFilter[];
    telegramSettings: TelegramSettings;
    onAddToFilter: (filterId: string, field: FilterListField) => void;
    onAddToNewFilter: (field: FilterListField) => void;
    onCopyLink: () => void;
    onSendTelegram: () => void;
    onViewProfile?: (researcherId: string, researcherName: string) => void;
    onMuteStudy?: (duration: MuteDuration) => void;
    onMuteResearcher?: (duration: MuteDuration) => void;
    onUnmuteStudy?: () => void;
    onUnmuteResearcher?: () => void;
    studyMuted?: boolean;
    researcherMuted?: boolean;
  }

  let {
    study,
    studyUrl,
    priorityFilters,
    telegramSettings,
    onAddToFilter,
    onAddToNewFilter,
    onCopyLink,
    onSendTelegram,
    onViewProfile,
    onMuteStudy,
    onMuteResearcher,
    onUnmuteStudy,
    onUnmuteResearcher,
    studyMuted = false,
    researcherMuted = false,
  }: Props = $props();

  type SubmenuKind = FilterListField | 'mute-study' | 'mute-researcher' | null;

  const MUTE_DURATIONS: { value: MuteDuration; label: string }[] = [
    { value: '1h', label: 'for 1 hour' },
    { value: '24h', label: 'for 24 hours' },
    { value: 'forever', label: 'until I un-mute' },
  ];

  const MENU_WIDTH = 224; // 14rem
  const MENU_ESTIMATED_HEIGHT = 170;
  const SUBMENU_WIDTH = 208; // 13rem
  const GAP = 4;

  let open = $state(false);
  let submenu: SubmenuKind = $state(null);
  let copiedHint = $state('');
  let triggerBtn: HTMLButtonElement | null = $state(null);
  let menuEl: HTMLDivElement | null = $state(null);
  let submenuEl: HTMLDivElement | null = $state(null);
  let menuPos = $state<{ left: number; top: number; flipUp: boolean } | null>(null);
  let submenuPos = $state<{ left: number; top: number } | null>(null);

  const hasResearcher = $derived(Boolean(study?.researcher?.id?.trim()));
  const researcherName = $derived(study?.researcher?.name?.trim() || study?.researcher?.id || '');
  const telegramConfigured = $derived(
    Boolean(telegramSettings?.enabled && telegramSettings?.bot_token && telegramSettings?.chat_id)
  );

  function computeMenuPos() {
    if (!triggerBtn) return null;
    const rect = triggerBtn.getBoundingClientRect();
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const flipUp = (viewportH - rect.bottom) < (MENU_ESTIMATED_HEIGHT + GAP + 8);
    const left = Math.min(
      Math.max(8, rect.right - MENU_WIDTH),
      viewportW - MENU_WIDTH - 8
    );
    const top = flipUp ? rect.top - GAP : rect.bottom + GAP;
    return { left, top, flipUp };
  }

  function computeSubmenuPos() {
    if (!menuEl) return null;
    const rect = menuEl.getBoundingClientRect();
    const viewportH = window.innerHeight;
    // Prefer opening to the left of the main menu (right-to-left menu style).
    // If there isn't room, open to the right.
    const openLeft = rect.left >= SUBMENU_WIDTH + GAP + 8;
    const left = openLeft ? rect.left - SUBMENU_WIDTH - GAP : rect.right + GAP;
    // Pin submenu top to the menu top, but clamp so the submenu doesn't fall below the viewport.
    const itemCount = submenu === 'match' || submenu === 'ignore'
      ? Math.min(priorityFilters.length, 6) + 1
      : MUTE_DURATIONS.length;
    const estimatedSubmenuHeight = 40 + itemCount * 32;
    const top = Math.min(rect.top, Math.max(8, viewportH - estimatedSubmenuHeight - 8));
    return { left, top };
  }

  function close() {
    open = false;
    submenu = null;
    menuPos = null;
    submenuPos = null;
  }

  function toggle(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (open) { close(); return; }
    menuPos = computeMenuPos();
    open = true;
  }

  function showSubmenu(e: MouseEvent, kind: SubmenuKind) {
    e.preventDefault();
    e.stopPropagation();
    if (!kind) return;
    // Researcher-scoped actions need a researcher; muting a study does not.
    const researcherScoped = kind === 'match' || kind === 'ignore' || kind === 'mute-researcher';
    if (researcherScoped && !hasResearcher) return;
    if (submenu === kind) { submenu = null; submenuPos = null; return; }
    submenu = kind;
    // Wait for the submenu to mount so computeSubmenuPos can measure its rect.
    tick().then(() => { submenuPos = computeSubmenuPos(); });
  }

  function handleAddToFilter(e: MouseEvent, filterId: string) {
    e.preventDefault();
    e.stopPropagation();
    if (submenu !== 'match' && submenu !== 'ignore') return;
    onAddToFilter(filterId, submenu);
    close();
  }

  function handleAddToNewFilter(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (submenu !== 'match' && submenu !== 'ignore') return;
    onAddToNewFilter(submenu);
    close();
  }

  function handleMute(e: MouseEvent, duration: MuteDuration) {
    e.preventDefault();
    e.stopPropagation();
    if (submenu === 'mute-study') onMuteStudy?.(duration);
    else if (submenu === 'mute-researcher') onMuteResearcher?.(duration);
    close();
  }

  function handleUnmuteStudy(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onUnmuteStudy?.();
    close();
  }

  function handleUnmuteResearcher(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onUnmuteResearcher?.();
    close();
  }

  function handleViewProfile(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!hasResearcher || !onViewProfile) return;
    const id = study?.researcher?.id?.trim() ?? '';
    // Pass the real name only (not the id fallback used for menu labels) so the profile can
    // resolve the name from the researchers table / past submissions when the study omits it.
    onViewProfile(id, study?.researcher?.name?.trim() ?? '');
    close();
  }

  function handleCopyLink(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    onCopyLink();
    copiedHint = 'Link copied';
    setTimeout(() => { copiedHint = ''; close(); }, 700);
  }

  function handleSendTelegram(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!telegramConfigured) return;
    onSendTelegram();
    close();
  }

  function onGlobalClick(e: MouseEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    if (triggerBtn && triggerBtn.contains(target)) return;
    if (menuEl && menuEl.contains(target)) return;
    if (submenuEl && submenuEl.contains(target)) return;
    close();
  }
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      close();
      triggerBtn?.focus();
    }
  }
  function onScrollOrResize() {
    // The menu is in fixed positioning — if the trigger scrolls away, close.
    close();
  }

  // Portal the menu to <body> so it doesn't inherit a transformed containing
  // block from the hovered study card (which has transform: translateY(-1px)
  // on hover — any ancestor transform makes position:fixed relative to it
  // instead of the viewport, causing the menu to snap to the wrong place).
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return () => {
      if (node.parentNode === document.body) node.remove();
    };
  }

  $effect(() => {
    if (open) {
      document.addEventListener('mousedown', onGlobalClick);
      document.addEventListener('keydown', onKeydown);
      window.addEventListener('resize', onScrollOrResize);
      // Capture scrolls from any ancestor scroll container.
      window.addEventListener('scroll', onScrollOrResize, true);
      return () => {
        document.removeEventListener('mousedown', onGlobalClick);
        document.removeEventListener('keydown', onKeydown);
        window.removeEventListener('resize', onScrollOrResize);
        window.removeEventListener('scroll', onScrollOrResize, true);
      };
    }
  });
</script>

<div class="study-action-menu inline-flex">
  <button
    bind:this={triggerBtn}
    type="button"
    class="menu-trigger btn btn-ghost btn-xs w-6 h-6 min-h-0 p-0 text-[14px] leading-none text-base-content/40 hover:text-base-content/80 hover:bg-base-content/10"
    aria-label="Study actions"
    title="Actions"
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={toggle}
  >&#x22EE;</button>
</div>

{#if open && menuPos}
  <div
    bind:this={menuEl}
    {@attach portal}
    class="menu-panel fixed w-56 bg-base-100 border border-base-300 rounded-lg shadow-xl"
    role="menu"
    style="left: {menuPos.left}px; {menuPos.flipUp ? `bottom: ${window.innerHeight - menuPos.top}px` : `top: ${menuPos.top}px`};"
  >
    {#if onViewProfile}
      <button
        type="button"
        class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 flex items-center gap-2 bg-transparent border-none cursor-pointer {hasResearcher ? 'text-base-content' : 'text-base-content/30 cursor-not-allowed'}"
        disabled={!hasResearcher}
        onclick={handleViewProfile}
        title={hasResearcher ? `View ${researcherName}'s reliability profile` : 'No researcher on this study'}
      >
        <span class="truncate">&#128100; View researcher profile</span>
      </button>
      <div class="border-t border-base-300 my-0.5"></div>
    {/if}
    <button
      type="button"
      class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-primary/10 flex items-center justify-between gap-2 bg-transparent border-none cursor-pointer {hasResearcher ? 'text-base-content' : 'text-base-content/30 cursor-not-allowed'}"
      disabled={!hasResearcher}
      onclick={(e) => showSubmenu(e, 'match')}
      title={hasResearcher ? `Prioritize ${researcherName}` : 'No researcher on this study'}
    >
      <span class="truncate">&#10022; Prioritize researcher</span>
      <span class="text-[10px] text-base-content/40">&#9656;</span>
    </button>
    <button
      type="button"
      class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-error/10 flex items-center justify-between gap-2 bg-transparent border-none cursor-pointer {hasResearcher ? 'text-base-content' : 'text-base-content/30 cursor-not-allowed'}"
      disabled={!hasResearcher}
      onclick={(e) => showSubmenu(e, 'ignore')}
      title={hasResearcher ? `Blacklist ${researcherName}` : 'No researcher on this study'}
    >
      <span class="truncate">&#128683; Blacklist researcher</span>
      <span class="text-[10px] text-base-content/40">&#9656;</span>
    </button>

    <div class="border-t border-base-300 my-0.5"></div>

    {#if studyMuted}
      <button
        type="button"
        class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 text-base-content bg-transparent border-none cursor-pointer flex items-center gap-2"
        onclick={handleUnmuteStudy}
        title="Show alerts for this study again"
      >
        <span class="truncate">&#128276; Un-mute this study</span>
      </button>
    {:else}
      <button
        type="button"
        class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 text-base-content bg-transparent border-none cursor-pointer flex items-center justify-between gap-2"
        onclick={(e) => showSubmenu(e, 'mute-study')}
        title="Silence alerts &amp; auto-open for this study"
      >
        <span class="truncate">&#128277; Mute this study</span>
        <span class="text-[10px] text-base-content/40">&#9656;</span>
      </button>
    {/if}
    {#if researcherMuted}
      <button
        type="button"
        class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 text-base-content bg-transparent border-none cursor-pointer flex items-center gap-2"
        onclick={handleUnmuteResearcher}
        title="Show alerts from this researcher again"
      >
        <span class="truncate">&#128276; Un-mute this researcher</span>
      </button>
    {:else}
      <button
        type="button"
        class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 flex items-center justify-between gap-2 bg-transparent border-none cursor-pointer {hasResearcher ? 'text-base-content' : 'text-base-content/30 cursor-not-allowed'}"
        disabled={!hasResearcher}
        onclick={(e) => showSubmenu(e, 'mute-researcher')}
        title={hasResearcher ? 'Silence every study from this researcher' : 'No researcher on this study'}
      >
        <span class="truncate">&#128277; Mute this researcher</span>
        <span class="text-[10px] text-base-content/40">&#9656;</span>
      </button>
    {/if}

    <div class="border-t border-base-300 my-0.5"></div>

    <button
      type="button"
      class="menu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 text-base-content bg-transparent border-none cursor-pointer flex items-center justify-between gap-2"
      disabled={!studyUrl}
      onclick={handleCopyLink}
    >
      <span>&#128279; Copy study link</span>
      {#if copiedHint}
        <span class="text-[10px] text-success">{copiedHint}</span>
      {/if}
    </button>
    <button
      type="button"
      class="menu-item w-full text-left px-3 py-1.5 text-[12px] bg-transparent border-none cursor-pointer flex items-center justify-between gap-2 {telegramConfigured ? 'text-base-content hover:bg-base-200' : 'text-base-content/30 cursor-not-allowed'}"
      disabled={!telegramConfigured}
      title={telegramConfigured ? 'Send this study to your Telegram' : 'Configure Telegram in Settings first'}
      onclick={handleSendTelegram}
    >
      <span>&#9993; Send to Telegram</span>
    </button>
  </div>

  {#if submenu && submenuPos}
    <div
      bind:this={submenuEl}
      {@attach portal}
      class="submenu-panel fixed w-52 bg-base-100 border border-base-300 rounded-lg shadow-xl"
      role="menu"
      style="left: {submenuPos.left}px; top: {submenuPos.top}px;"
    >
      <div class="px-3 pt-1.5 pb-1 text-[10px] uppercase tracking-wider text-base-content/45 font-semibold">
        {submenu === 'match'
          ? 'Prioritize in…'
          : submenu === 'ignore'
            ? 'Blacklist in…'
            : submenu === 'mute-study'
              ? 'Mute this study…'
              : 'Mute this researcher…'}
      </div>
      {#if submenu === 'mute-study' || submenu === 'mute-researcher'}
        {#each MUTE_DURATIONS as d (d.value)}
          <button
            type="button"
            class="submenu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 text-base-content bg-transparent border-none cursor-pointer flex items-center gap-2"
            onclick={(e) => handleMute(e, d.value)}
          >
            <span class="truncate">{d.label}</span>
          </button>
        {/each}
      {:else}
        {#if priorityFilters.length === 0}
          <div class="px-3 pb-2 text-[11px] text-base-content/50">No filters yet.</div>
        {:else}
          {#each priorityFilters as f (f.id)}
            <button
              type="button"
              class="submenu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-base-200 text-base-content bg-transparent border-none cursor-pointer flex items-center justify-between gap-2"
              onclick={(e) => handleAddToFilter(e, f.id)}
            >
              <span class="truncate">{f.name || 'Filter'}</span>
              {#if !f.enabled}
                <span class="text-[9px] text-base-content/40">off</span>
              {/if}
            </button>
          {/each}
        {/if}
        <div class="border-t border-base-300 my-0.5"></div>
        <button
          type="button"
          class="submenu-item w-full text-left px-3 py-1.5 text-[12px] hover:bg-primary/10 text-primary font-medium bg-transparent border-none cursor-pointer"
          onclick={handleAddToNewFilter}
        >+ New filter…</button>
      {/if}
    </div>
  {/if}
{/if}

<style>
  .menu-panel, .submenu-panel {
    min-width: 12rem;
    z-index: 9999;
  }
  .submenu-panel {
    z-index: 10000;
  }
</style>
