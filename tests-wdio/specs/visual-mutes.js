// Visual audit for issue #21: snooze/block mutes + auto-open-during-submission.
// Seeds studies + mutes, then screenshots the muted Live badge, the study action
// menu (mute entries + duration submenu), and the two new Settings cards.
// Screenshots land in screenshots/visual/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POPUP_URL } from '../helpers/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'screenshots', 'visual');

async function setTheme(theme) {
  await browser.execute((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

async function seedStudiesAndMutes(count) {
  const result = await browser.executeAsync((n, done) => {
    const run = async () => {
      if (!window.__ppDev) { done({ error: 'no __ppDev' }); return; }
      await window.__ppDev.clearStudies();
      const seeded = await window.__ppDev.seedStudies(n);
      const muted = await window.__ppDev.seedMutes();
      done({ seeded, muted });
    };
    run().catch((e) => done({ error: String(e) }));
  }, count);
  console.log(`  seeded ${result.seeded} studies, ${result.muted} mutes (${result.error || 'ok'})`);
  return result;
}

async function navigateToTab(tab) {
  await browser.execute((t) => {
    const btn = document.querySelector(`button[data-tab="${t}"]`);
    if (btn) btn.click();
  }, tab);
  await browser.pause(150);
}

async function resizeWindow() {
  try {
    await browser.setWindowRect(0, 0, 620, 760);
  } catch {
    try { await browser.setWindowSize(620, 760); } catch { /* ignore */ }
  }
}

async function screenshot(name) {
  const filePath = path.join(OUT_DIR, `${name}.png`);
  await browser.saveScreenshot(filePath);
  console.log(`  saved: ${filePath}`);
}

describe('Visual: Mutes (issue #21)', () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seedMutes === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev.seedMutes not available' },
    );
    await resizeWindow();
    await seedStudiesAndMutes(12);
    await browser.url(POPUP_URL);
    await browser.pause(400);
  });

  it('screenshots the muted badge in Live (light)', async () => {
    await navigateToTab('live');
    await setTheme('light');
    await browser.pause(150);
    await screenshot('mutes-live-light');
  });

  it('screenshots the muted badge in Live (dark)', async () => {
    await navigateToTab('live');
    await setTheme('dark');
    await browser.pause(150);
    await screenshot('mutes-live-dark');
  });

  it('screenshots the study action menu with mute entries', async () => {
    await setTheme('light');
    await navigateToTab('live');
    await browser.pause(150);
    // Open the first study's action menu.
    await browser.execute(() => {
      const trigger = document.querySelector('#panelLive .menu-trigger');
      if (trigger) trigger.click();
    });
    await browser.pause(200);
    await screenshot('mutes-menu-light');
  });

  it('screenshots the mute-duration submenu', async () => {
    // With the menu open, click "Mute this study" to reveal the duration submenu.
    await browser.execute(() => {
      const items = Array.from(document.querySelectorAll('.menu-panel .menu-item'));
      const muteItem = items.find((el) => /mute this study/i.test(el.textContent || ''));
      if (muteItem) muteItem.click();
    });
    await browser.pause(250);
    await screenshot('mutes-submenu-light');
    // Close the menu.
    await browser.execute(() => document.body.click());
    await browser.pause(100);
  });

  it('screenshots the new Settings cards (light)', async () => {
    await navigateToTab('settings');
    await setTheme('light');
    await browser.pause(200);
    // Ensure the mute card is scrolled into view.
    await browser.execute(() => {
      document.querySelector('#mutesCard')?.scrollIntoView({ block: 'center' });
    });
    await browser.pause(150);
    await screenshot('mutes-settings-light');
  });

  it('screenshots the new Settings cards (dark)', async () => {
    await navigateToTab('settings');
    await setTheme('dark');
    await browser.pause(150);
    await browser.execute(() => {
      document.querySelector('#autoOpenDuringSubmissionCard')?.scrollIntoView({ block: 'start' });
    });
    await browser.pause(150);
    await screenshot('mutes-settings-dark');
  });
});
