import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POPUP_URL } from '../helpers/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'screenshots', 'visual');

async function setTheme(theme) {
  await browser.execute((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

async function navigateToSettings() {
  await browser.execute(() => {
    const tab = document.querySelector('button[data-tab="settings"]');
    if (tab) tab.click();
  });
  await browser.pause(100);
}

async function addFilter() {
  await browser.execute(() => {
    const btn = document.querySelector('#addFilterButton');
    if (btn) btn.click();
  });
  await browser.pause(200);
}

async function screenshot(name) {
  const filePath = path.join(OUT_DIR, `${name}.png`);
  await browser.saveScreenshot(filePath);
  console.log(`  saved: ${filePath}`);
}

describe('visual: settings panel (quiet hours + desktop notify)', () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seedStudies === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev not available' },
    );
  });

  it('captures settings panel with filter expanded', async () => {
    await navigateToSettings();
    await addFilter();
    await browser.pause(200);

    // Enable quiet hours and desktop notify on the first filter
    await browser.execute(() => {
      const quietToggle = document.querySelector('[aria-label="Enable quiet hours"]');
      if (quietToggle && !quietToggle.checked) quietToggle.click();
      const desktopToggle = document.querySelector('[aria-label="Send desktop notification"]');
      if (desktopToggle && !desktopToggle.checked) desktopToggle.click();
    });
    await browser.pause(200);

    // Scroll the filter card into view
    await browser.execute(() => {
      const filterCard = document.querySelector('.filter-card');
      if (filterCard) filterCard.scrollIntoView({ block: 'start' });
    });
    await browser.pause(100);

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await browser.pause(100);
      await screenshot(`settings-filter-expanded-${theme}`);
    }
  });

  it('captures collapsed filter badges', async () => {
    await browser.execute(() => {
      const btn = document.querySelector('[aria-label="Collapse filter"]');
      if (btn) btn.click();
    });
    await browser.pause(200);

    await browser.execute(() => {
      const filterCard = document.querySelector('.filter-card');
      if (filterCard) filterCard.scrollIntoView({ block: 'start' });
    });
    await browser.pause(100);

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await browser.pause(100);
      await screenshot(`settings-filter-collapsed-${theme}`);
    }
  });
});
