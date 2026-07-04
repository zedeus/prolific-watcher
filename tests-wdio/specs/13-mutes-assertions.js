// E2E assertion spec for the snooze/block (mute) feature (issue #21).
// Seeds fake studies via __ppDev, then drives the real popup ↔ background
// round-trip: mute a study from the action menu, assert the "muted" badge
// appears and persists across a reload, then un-mute it from Settings and
// assert the badge is gone. Runs under wdio.visual.conf.js (dev build, no login).

import { POPUP_URL } from '../helpers/constants.js';

async function seedStudies(count) {
  const result = await browser.executeAsync((n, done) => {
    const run = async () => {
      if (!window.__ppDev) { done({ error: 'no __ppDev' }); return; }
      await window.__ppDev.clearStudies();
      await window.__ppDev.clearMutes();
      const c = await window.__ppDev.seedStudies(n);
      done({ count: c });
    };
    run().catch((e) => done({ error: String(e) }));
  }, count);
  if (result.error) throw new Error(`seed failed: ${result.error}`);
  return result.count;
}

async function gotoTab(tab) {
  await browser.execute((t) => {
    const btn = document.querySelector(`button[data-tab="${t}"]`);
    if (btn) btn.click();
  }, tab);
  await browser.pause(200);
}

async function reloadPopup() {
  await browser.url(POPUP_URL);
  await browser.pause(400);
}

function countMutedBadges() {
  return browser.execute(() => document.querySelectorAll('[title^="Muted"]').length);
}

async function resizeWindow() {
  try {
    await browser.setWindowRect(0, 0, 620, 800);
  } catch {
    try { await browser.setWindowSize(620, 800); } catch { /* ignore */ }
  }
}

describe('Mute (snooze/block) assertions', () => {
  before(async () => {
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seedStudies === 'function' && typeof window.__ppDev?.clearMutes === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev mute helpers not available' },
    );
    await resizeWindow();
    await seedStudies(12);
    await reloadPopup();
    await gotoTab('live');
  });

  it('starts with no muted studies', async () => {
    expect(await countMutedBadges()).toBe(0);
  });

  it('mutes a study for 1 hour from the action menu and shows the badge', async () => {
    // Open the first study's action menu.
    await browser.execute(() => {
      const trigger = document.querySelector('#panelLive .menu-trigger');
      if (trigger) trigger.click();
    });
    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.menu-panel')), {
      timeout: 3000, timeoutMsg: 'action menu did not open',
    });

    // Click "Mute this study" to open the duration submenu.
    const clickedMute = await browser.execute(() => {
      const items = Array.from(document.querySelectorAll('.menu-panel .menu-item'));
      const el = items.find((n) => (n.textContent || '').includes('Mute this study'));
      if (el) { el.click(); return true; }
      return false;
    });
    expect(clickedMute).toBe(true);

    await browser.waitUntil(async () => browser.execute(() => !!document.querySelector('.submenu-panel')), {
      timeout: 3000, timeoutMsg: 'mute duration submenu did not open',
    });

    // Choose "for 1 hour".
    const clickedDuration = await browser.execute(() => {
      const items = Array.from(document.querySelectorAll('.submenu-panel .submenu-item'));
      const el = items.find((n) => /for 1 hour/i.test(n.textContent || ''));
      if (el) { el.click(); return true; }
      return false;
    });
    expect(clickedDuration).toBe(true);

    // The badge should appear once the background persists + the popup re-reads.
    await browser.waitUntil(async () => (await countMutedBadges()) >= 1, {
      timeout: 5000, timeoutMsg: 'muted badge did not appear after muting',
    });
  });

  it('persists the mute across a popup reload', async () => {
    await reloadPopup();
    await gotoTab('live');
    await browser.waitUntil(async () => (await countMutedBadges()) >= 1, {
      timeout: 5000, timeoutMsg: 'muted badge did not survive reload',
    });
  });

  it('lists the mute in Settings and un-mutes it', async () => {
    await gotoTab('settings');
    // Mute list should have exactly one entry.
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll('#mutesList > div').length === 1),
      { timeout: 4000, timeoutMsg: 'mute not listed in Settings' },
    );

    // Click the un-mute (✕) button.
    const clickedUnmute = await browser.execute(() => {
      const btn = document.querySelector('#mutesList button[aria-label^="Un-mute"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    expect(clickedUnmute).toBe(true);

    // The list should empty out (the #mutesList element unmounts).
    await browser.waitUntil(
      async () => browser.execute(() => document.querySelectorAll('#mutesList > div').length === 0),
      { timeout: 4000, timeoutMsg: 'mute was not removed from Settings' },
    );
  });

  it('removes the badge from Live after un-muting', async () => {
    await gotoTab('live');
    await browser.waitUntil(async () => (await countMutedBadges()) === 0, {
      timeout: 5000, timeoutMsg: 'muted badge lingered after un-mute',
    });
  });
});
