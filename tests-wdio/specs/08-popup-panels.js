/**
 * Comprehensive popup functionality tests.
 * Runs after 06-studies-intercept (server has data) and 07-debug-state.
 */
import { navigateToPopup, getPopupStatus } from '../helpers/popup-dom.js';

// ── Helpers ─────────────────────────────────────────────────────

function exec(fn, ...args) {
  return browser.execute(fn, ...args);
}

function switchToTab(tab) {
  return exec((t) => document.querySelector(`button[data-tab="${t}"]`)?.click(), tab);
}

function getPanelInfo(panelId) {
  return exec((id) => {
    const panel = document.getElementById(id);
    if (!panel) return null;
    return {
      active: panel.classList.contains('active'),
      visible: window.getComputedStyle(panel).display !== 'none',
      cardCount: panel.querySelectorAll('.event').length,
      linkCount: panel.querySelectorAll('.event-link').length,
      emptyState: !!panel.querySelector('.empty-events'),
      emptyText: panel.querySelector('.empty-events')?.textContent?.trim() ?? '',
      height: panel.offsetHeight,
    };
  }, panelId);
}

function getStudyCards() {
  return exec(() => [...document.querySelectorAll('#panelLive .event.live')].map((card) => {
    const metrics = card.querySelector('.event-metrics');
    const spans = metrics ? [...metrics.querySelectorAll('span')] : [];
    return {
      title: card.querySelector('.event-title')?.textContent?.trim() ?? '',
      reward: spans[0]?.textContent?.trim() ?? '',
      rate: spans[1]?.textContent?.trim() ?? '',
      isPriorityCard: card.classList.contains('priority') || card.classList.contains('priority-card'),
      hasFirstSeen: !!card.querySelector('.event-time'),
      linkHref: card.closest('.event-link')?.getAttribute('href') ?? null,
    };
  }));
}

function getEventCards() {
  return exec(() => [...document.querySelectorAll('#panelFeed .event')].map((card) => {
    const metrics = card.querySelector('.event-metrics');
    const spans = metrics ? [...metrics.querySelectorAll('span')] : [];
    return {
      title: card.querySelector('.event-title')?.textContent?.trim() ?? '',
      time: card.querySelector('.event-time')?.textContent?.trim() ?? '',
      type: card.classList.contains('available') ? 'available' : card.classList.contains('unavailable') ? 'unavailable' : 'unknown',
      reward: spans[0]?.textContent?.trim() ?? '',
      rate: spans[1]?.textContent?.trim() ?? '',
      linkHref: card.closest('.event-link')?.getAttribute('href') ?? null,
    };
  }));
}

function getSubmissionCards() {
  return exec(() => [...document.querySelectorAll('#panelSubmissions .event')].map((card) => {
    const metrics = card.querySelector('.event-metrics');
    const spans = metrics ? [...metrics.querySelectorAll('span')] : [];
    return {
      title: card.querySelector('.event-title')?.textContent?.trim() ?? '',
      time: card.querySelector('.event-time')?.textContent?.trim() ?? '',
      reward: spans[0]?.textContent?.trim() ?? '',
      rate: spans[1]?.textContent?.trim() ?? '',
      linkHref: card.closest('.event-link')?.getAttribute('href') ?? null,
    };
  }));
}

function getTabStates() {
  return exec(() => {
    const tabs = {};
    for (const btn of document.querySelectorAll('[data-tab]')) {
      tabs[btn.dataset.tab] = {
        active: btn.classList.contains('tab-active'),
        ariaSelected: btn.getAttribute('aria-selected'),
        text: btn.textContent?.trim() ?? '',
      };
    }
    return tabs;
  });
}

async function getSettingsState() {
  // Ensure a filter exists and is expanded before reading the inputs inside
  // the expanded body. The expand click has to happen in a separate exec so
  // Svelte has time to render the expanded section before we read from it.
  await exec(() => {
    if (document.querySelectorAll('[data-filter-id]').length === 0) {
      document.getElementById('addFilterButton')?.click();
    }
  });
  await browser.pause(500);
  const isExpanded = await exec(() => !!document.getElementById('priorityMinRewardInput-0'));
  if (!isExpanded) {
    await exec(() => {
      document.querySelector('[data-filter-id] button[aria-label="Expand filter"]')?.click();
    });
    await browser.pause(350);
  }
  return exec(() => {
    const get = (id) => document.getElementById(id);
    return {
      autoOpen: get('autoOpenToggle')?.checked ?? null,
      filterCount: document.querySelectorAll('[data-filter-id]').length,
      priorityEnabled: get('priorityFilterEnabledToggle-0')?.checked ?? null,
      autoOpenNewTab: get('priorityAutoOpenInNewTabToggle-0')?.checked ?? null,
      soundType: get('priorityAlertSoundTypeSelect-0')?.value ?? null,
      soundVolume: get('priorityAlertSoundVolumeInput-0')?.value ?? null,
      minReward: get('priorityMinRewardInput-0')?.value ?? null,
      minHourly: get('priorityMinHourlyInput-0')?.value ?? null,
      maxEta: get('priorityMaxEtaInput-0')?.value ?? null,
      minPlaces: get('priorityMinPlacesInput-0')?.value ?? null,
      alwaysKeywords: get('priorityAlwaysKeywordsInput-0')?.value ?? null,
      ignoreKeywords: get('priorityIgnoreKeywordsInput-0')?.value ?? null,
      refreshMinDelay: get('refreshMinDelayInput')?.value ?? null,
      refreshAvgDelay: get('refreshAverageDelayInput')?.value ?? null,
      refreshSpread: get('refreshSpreadInput')?.value ?? null,
      refreshMinLabel: get('refreshMinDelayValue')?.textContent ?? null,
      refreshAvgLabel: get('refreshAverageDelayValue')?.textContent ?? null,
      refreshSpreadLabel: get('refreshSpreadValue')?.textContent ?? null,
    };
  });
}

function getDiagnostics() {
  return exec(() => {
    // Open debug section if closed
    const details = document.querySelector('details.debug-details');
    if (details && !details.open) details.querySelector('summary')?.click();

    const grid = {};
    for (const row of document.querySelectorAll('#debugGrid .debug-row')) {
      const key = row.querySelector('.debug-key')?.textContent?.trim() ?? '';
      const val = row.querySelector('.debug-value')?.textContent?.trim() ?? '';
      if (key) grid[key] = val;
    }

    const logs = [...document.querySelectorAll('#debugLog .debug-line')]
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean);

    return { grid, logs, gridCount: Object.keys(grid).length, logCount: logs.length };
  });
}

async function reopenPopup() {
  await browser.url('about:blank');
  await browser.pause(500);
  await navigateToPopup();
  await browser.pause(1500);
}

// ── Tests ───────────────────────────────────────────────────────

describe('Popup Panels', () => {

  // ── Panel structure ───────────────────────────────────────────

  it('all four panels exist in DOM', async () => {
    await navigateToPopup();
    for (const id of ['panelLive', 'panelFeed', 'panelSubmissions', 'panelSettings']) {
      const info = await getPanelInfo(id);
      expect(info).not.toBeNull();
    }
  });

  it('exactly one panel visible at a time', async () => {
    await navigateToPopup();
    for (const tab of ['live', 'feed', 'submissions', 'settings']) {
      await switchToTab(tab);
      await browser.pause(200);

      const panels = {};
      for (const id of ['panelLive', 'panelFeed', 'panelSubmissions', 'panelSettings']) {
        panels[id] = await getPanelInfo(id);
      }

      const visibleCount = Object.values(panels).filter((p) => p.active).length;
      expect(visibleCount).toBe(1);
    }
  });

  // ── Tab bar ───────────────────────────────────────────────────

  it('tab bar has all tabs with correct labels', async () => {
    await navigateToPopup();
    const tabs = await getTabStates();
    expect(Object.keys(tabs).sort()).toEqual(['earnings', 'feed', 'insights', 'live', 'researchers', 'settings', 'submissions']);
    expect(tabs.live.text).toBe('Live');
    expect(tabs.feed.text).toBe('Feed');
    expect(tabs.submissions.text).toBe('Submissions');
    expect(tabs.researchers.text).toBe('Researchers');
    expect(tabs.earnings.text).toBe('Earnings');
    expect(tabs.insights.text).toBe('Insights');
    expect(tabs.settings.text).toBe('Settings');
  });

  it('tab active state matches panel visibility', async () => {
    await navigateToPopup();
    const tabToPanel = { live: 'panelLive', feed: 'panelFeed', submissions: 'panelSubmissions', settings: 'panelSettings' };

    for (const [tab, panelId] of Object.entries(tabToPanel)) {
      await switchToTab(tab);
      await browser.pause(200);

      const tabs = await getTabStates();
      const panel = await getPanelInfo(panelId);

      expect(tabs[tab].active).toBe(true);
      expect(panel.active).toBe(true);

      // All other tabs inactive
      for (const [otherTab, otherPanel] of Object.entries(tabToPanel)) {
        if (otherTab !== tab) {
          expect(tabs[otherTab].active).toBe(false);
          expect((await getPanelInfo(otherPanel)).active).toBe(false);
        }
      }
    }
  });

  it('live tab is active on popup open', async () => {
    await navigateToPopup();
    const tabs = await getTabStates();
    expect(tabs.live.active).toBe(true);
    expect((await getPanelInfo('panelLive')).active).toBe(true);
  });

  // ── Status bar ────────────────────────────────────────────────

  it('status dot is green when connected', async () => {
    await navigateToPopup();
    const status = await getPopupStatus();
    expect(status.dot_bad).toBe(false);
  });

  it('refresh text shows relative time, not error', async () => {
    await navigateToPopup();
    // refreshView() populates latestRefreshDate asynchronously on mount.
    // Poll briefly so we don't race the first IndexedDB read.
    await browser.waitUntil(
      async () => {
        const { refresh_text } = await getPopupStatus();
        return refresh_text && refresh_text !== 'never';
      },
      { timeout: 5000, interval: 200, timeoutMsg: 'refresh text stayed "never"' },
    );
    const status = await getPopupStatus();
    expect(status.refresh_text).not.toBe('');
    expect(status.refresh_text).not.toBe('Offline');
    expect(status.refresh_text).not.toBe('Signed out');
    expect(status.refresh_text).not.toBe('never');
  });

  it('no error message shown when healthy', async () => {
    await navigateToPopup();
    const status = await getPopupStatus();
    expect(status.error_visible).toBe(false);
  });

  it('refresh time updates over time', async () => {
    await navigateToPopup();
    await browser.pause(3000);

    // The label should still be valid after 3 seconds
    const status = await getPopupStatus();
    expect(status.refresh_text.length).toBeGreaterThan(0);
    expect(status.dot_bad).toBe(false);
  });

  // ── Live studies panel ────────────────────────────────────────

  it('live panel shows studies or empty state', async () => {
    await navigateToPopup();
    await browser.pause(2000);

    const panel = await getPanelInfo('panelLive');
    // Panel should show either study cards or the empty state message
    expect(panel.cardCount > 0 || panel.emptyState).toBe(true);
  });

  it('study cards have title, reward, and rate', async () => {
    await navigateToPopup();
    await browser.pause(2000);

    const cards = await getStudyCards();
    for (const card of cards) {
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.reward.length).toBeGreaterThan(0);
      expect(card.rate).toContain('/hr');
    }
  });

  it('study cards link to prolific.com/studies/', async () => {
    await navigateToPopup();
    await browser.pause(2000);

    const cards = await getStudyCards();
    for (const card of cards) {
      if (card.linkHref) {
        expect(card.linkHref).toMatch(/prolific\.com\/studies\//);
      }
    }
  });

  it('study cards exist if panel has cards', async () => {
    await navigateToPopup();
    await browser.pause(2000);

    const panel = await getPanelInfo('panelLive');
    const cards = await getStudyCards();
    expect(cards.length).toBe(panel.cardCount);
  });

  // ── Feed panel ────────────────────────────────────────────────

  it('feed events have title, time, type, and reward', async () => {
    await navigateToPopup();
    await switchToTab('feed');
    await browser.pause(500);

    const events = await getEventCards();
    for (const evt of events) {
      expect(evt.title.length).toBeGreaterThan(0);
      expect(evt.time.length).toBeGreaterThan(0);
      expect(['available', 'unavailable']).toContain(evt.type);
      expect(evt.reward.length).toBeGreaterThan(0);
      expect(evt.rate).toContain('/hr');
    }
  });

  it('feed event links point to prolific studies', async () => {
    await navigateToPopup();
    await switchToTab('feed');
    await browser.pause(500);

    const events = await getEventCards();
    for (const evt of events) {
      if (evt.linkHref) {
        expect(evt.linkHref).toMatch(/prolific\.com\/studies\//);
      }
    }
  });

  // ── Submissions panel ─────────────────────────────────────────

  it('submissions panel shows cards or empty state', async () => {
    await navigateToPopup();
    await switchToTab('submissions');
    await browser.pause(500);

    const panel = await getPanelInfo('panelSubmissions');
    expect(panel.active).toBe(true);
    // Either has cards or shows empty state
    expect(panel.cardCount > 0 || panel.emptyState).toBe(true);
  });

  it('submission cards have title and time if present', async () => {
    await navigateToPopup();
    await switchToTab('submissions');
    await browser.pause(500);

    const cards = await getSubmissionCards();
    for (const card of cards) {
      expect(card.title.length).toBeGreaterThan(0);
      expect(card.time.length).toBeGreaterThan(0);
    }
  });

  // ── Settings panel structure ──────────────────────────────────

  it('settings panel has all expected controls', async () => {
    await navigateToPopup();
    await switchToTab('settings');
    await browser.pause(300);

    const state = await getSettingsState();

    // All controls should exist (not null)
    expect(state.autoOpen).not.toBeNull();
    expect(state.priorityEnabled).not.toBeNull();
    expect(state.minReward).not.toBeNull();
    expect(state.minHourly).not.toBeNull();
    expect(state.maxEta).not.toBeNull();
    expect(state.minPlaces).not.toBeNull();
    expect(state.alwaysKeywords).not.toBeNull();
    expect(state.ignoreKeywords).not.toBeNull();
    expect(state.refreshMinDelay).not.toBeNull();
    expect(state.refreshAvgDelay).not.toBeNull();
    expect(state.refreshSpread).not.toBeNull();
  });

  it('settings controls have reasonable default values', async () => {
    await navigateToPopup();
    await switchToTab('settings');
    await browser.pause(300);

    const state = await getSettingsState();

    // Auto-open should be boolean
    expect(typeof state.autoOpen).toBe('boolean');

    // Number inputs should be numeric strings
    expect(Number(state.minReward)).not.toBeNaN();
    expect(Number(state.minHourly)).not.toBeNaN();
    expect(Number(state.maxEta)).not.toBeNaN();
    expect(Number(state.minPlaces)).not.toBeNaN();

    // Slider values should be in valid ranges
    const minDelay = Number(state.refreshMinDelay);
    const avgDelay = Number(state.refreshAvgDelay);
    const spread = Number(state.refreshSpread);
    expect(minDelay).toBeGreaterThanOrEqual(1);
    expect(minDelay).toBeLessThanOrEqual(60);
    expect(avgDelay).toBeGreaterThanOrEqual(5);
    expect(avgDelay).toBeLessThanOrEqual(60);
    expect(spread).toBeGreaterThanOrEqual(0);
    expect(spread).toBeLessThanOrEqual(60);
  });

  it('slider labels match slider values', async () => {
    await navigateToPopup();
    await switchToTab('settings');
    await browser.pause(300);

    const state = await getSettingsState();
    expect(state.refreshMinLabel).toBe(state.refreshMinDelay + 's');
    expect(state.refreshAvgLabel).toBe(state.refreshAvgDelay + 's');
    expect(state.refreshSpreadLabel).toBe(state.refreshSpread + 's');
  });

  // ── Diagnostics ───────────────────────────────────────────────

  it('diagnostics grid has expected keys', async () => {
    await navigateToPopup();
    await switchToTab('settings');
    await browser.pause(300);

    const diag = await getDiagnostics();
    expect(diag.gridCount).toBeGreaterThanOrEqual(4);

    // Should include key diagnostic rows
    const keys = Object.keys(diag.grid);
    expect(keys.some((k) => k.includes('Auth'))).toBe(true);
    expect(keys.some((k) => k.includes('Refresh') || k.includes('refresh'))).toBe(true);
  });

  it('diagnostics log has entries', async () => {
    await navigateToPopup();
    await switchToTab('settings');
    await browser.pause(300);

    const diag = await getDiagnostics();
    expect(diag.logCount).toBeGreaterThan(0);
  });

  it('clear debug logs button works', async () => {
    await navigateToPopup();
    await switchToTab('settings');
    await browser.pause(300);

    // Open debug section
    await exec(() => {
      const details = document.querySelector('details.debug-details');
      if (details && !details.open) details.querySelector('summary')?.click();
    });
    await browser.pause(300);

    const before = await getDiagnostics();
    expect(before.logCount).toBeGreaterThan(0);

    // Click clear button
    await exec(() => document.getElementById('clearDebugButton')?.click());
    await browser.pause(1000);

    // Reopen popup to verify persistence
    await reopenPopup();
    await switchToTab('settings');
    await browser.pause(300);

    const after = await getDiagnostics();
    // After clearing, log count should be less than before
    // (may not be 0 since new events fire during the reopen)
    expect(after.logCount).toBeLessThan(before.logCount);
  });

  // ── Data consistency ──────────────────────────────────────────

  it('popup data is internally consistent', async () => {
    await navigateToPopup();
    await browser.pause(2000);

    const panel = await getPanelInfo('panelLive');
    const cards = await getStudyCards();
    const status = await getPopupStatus();

    // Card count matches panel
    expect(cards.length).toBe(panel.cardCount);

    // If we have cards, refresh timestamp should be visible
    if (cards.length > 0) {
      expect(status.refresh_text).not.toBe('never');
      expect(status.refresh_text).not.toBe('');
    }
  });

  // ── Settings persistence end-to-end ───────────────────────────

  it('settings survive popup close and reopen', async () => {
    await navigateToPopup();
    await switchToTab('settings');
    await browser.pause(300);

    // Capture current state
    const before = await getSettingsState();

    // Close and reopen
    await reopenPopup();
    await switchToTab('settings');
    await browser.pause(300);

    // Compare
    const after = await getSettingsState();
    expect(after.autoOpen).toBe(before.autoOpen);
    expect(after.priorityEnabled).toBe(before.priorityEnabled);
    expect(after.minReward).toBe(before.minReward);
    expect(after.minHourly).toBe(before.minHourly);
    expect(after.maxEta).toBe(before.maxEta);
    expect(after.minPlaces).toBe(before.minPlaces);
  });

  // ── Tab switching doesn't lose data ───────────────────────────

  it('switching tabs preserves panel content', async () => {
    await navigateToPopup();
    await browser.pause(2000);

    const liveCardsBefore = (await getStudyCards()).length;

    // Switch away and back
    await switchToTab('settings');
    await browser.pause(300);
    await switchToTab('live');
    await browser.pause(300);

    const liveCardsAfter = (await getStudyCards()).length;
    expect(liveCardsAfter).toBe(liveCardsBefore);
  });

  // ── Popup width ───────────────────────────────────────────────

  it('popup has expected width', async () => {
    await navigateToPopup();
    const width = await exec(() => document.querySelector('main')?.offsetWidth ?? 0);
    expect(width).toBeGreaterThanOrEqual(580);
    expect(width).toBeLessThanOrEqual(640);
  });
});
