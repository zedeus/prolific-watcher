// E2E assertion + visual spec for the global pause feature (issue #21).
// Seeds fake studies, drives the header Pause control through the real
// background (setPaused round-trip), asserts the paused UI + stored flag,
// resumes, and captures screenshots. Runs under wdio.visual.conf.js (no login).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POPUP_URL } from '../helpers/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'screenshots', 'visual');

async function seedStudies(count) {
  const result = await browser.executeAsync((n, done) => {
    const run = async () => {
      if (!window.__ppDev) { done({ error: 'no __ppDev' }); return; }
      await window.__ppDev.clearStudies();
      const c = await window.__ppDev.seedStudies(n);
      done({ count: c });
    };
    run().catch((e) => done({ error: String(e) }));
  }, count);
  if (result.error) throw new Error(`seed failed: ${result.error}`);
  return result.count;
}

async function clearPause() {
  await browser.executeAsync((done) => {
    browser.storage.local.set({ globalPause: null }).then(done).catch(() => done());
  });
}

function isPausedUI() {
  return browser.execute(() =>
    !!document.querySelector('#pausedBanner') &&
    !!document.querySelector('#resumeButton') &&
    !!document.querySelector('#syncDot.paused'),
  );
}

function storedPauseIsActive() {
  return browser.executeAsync((done) => {
    browser.storage.local.get('globalPause').then((d) => {
      const v = d.globalPause;
      done(!!v && typeof v === 'object' && (v.until === null || v.until > Date.now()));
    }).catch(() => done(false));
  });
}

async function gotoTab(tab) {
  await browser.execute((t) => {
    const btn = document.querySelector(`button[data-tab="${t}"]`);
    if (btn) btn.click();
  }, tab);
  await browser.pause(150);
}

async function reloadPopup() {
  await browser.url(POPUP_URL);
  await browser.pause(400);
}

async function resizeWindow() {
  try { await browser.setWindowRect(0, 0, 620, 760); } catch { try { await browser.setWindowSize(620, 760); } catch { /* ignore */ } }
}

async function screenshot(name) {
  await browser.saveScreenshot(path.join(OUT_DIR, `${name}.png`));
}

describe('Global pause assertions (issue #21)', () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seedStudies === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev not available' },
    );
    await resizeWindow();
    await seedStudies(10);
    await clearPause();
    await reloadPopup();
    await gotoTab('live');
  });

  it('starts not paused', async () => {
    expect(await isPausedUI()).toBe(false);
    await browser.execute(() => document.querySelector('#pauseButton')?.closest('details')?.setAttribute('open', ''));
    await browser.pause(150);
    await screenshot('pause-menu-light');
  });

  it('pauses for 1 hour from the header control', async () => {
    const clicked = await browser.execute(() => {
      const items = Array.from(document.querySelectorAll('#pauseButton ~ ul button, .dropdown-content button'));
      const el = items.find((n) => /1 hour/i.test(n.textContent || ''));
      if (el) { el.click(); return true; }
      return false;
    });
    expect(clicked).toBe(true);

    await browser.waitUntil(async () => isPausedUI(), { timeout: 5000, timeoutMsg: 'paused UI did not appear' });
    expect(await storedPauseIsActive()).toBe(true);
    await screenshot('pause-paused-light');
  });

  it('persists the pause across a reload', async () => {
    await reloadPopup();
    await gotoTab('live');
    await browser.waitUntil(async () => isPausedUI(), { timeout: 5000, timeoutMsg: 'pause did not survive reload' });
  });

  it('shows the paused state in Settings and resumes from there', async () => {
    await gotoTab('settings');
    await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('#settingsResumeButton')),
      { timeout: 4000, timeoutMsg: 'Settings pause card not in paused state' },
    );
    await browser.execute(() => {
      document.documentElement.setAttribute('data-theme', 'dark');
      document.querySelector('#pauseCard')?.scrollIntoView({ block: 'start' });
    });
    await browser.pause(150);
    await screenshot('pause-settings-dark');
    await browser.execute(() => document.documentElement.setAttribute('data-theme', 'light'));

    await browser.execute(() => document.querySelector('#settingsResumeButton')?.click());
    await browser.waitUntil(async () => (await storedPauseIsActive()) === false, {
      timeout: 5000, timeoutMsg: 'pause was not cleared on resume',
    });
  });

  it('removes the paused UI after resuming', async () => {
    await gotoTab('live');
    await browser.waitUntil(async () => (await isPausedUI()) === false, {
      timeout: 5000, timeoutMsg: 'paused UI lingered after resume',
    });
  });
});
