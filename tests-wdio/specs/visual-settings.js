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

describe('visual: settings panel (filters with new criteria)', () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seedStudies === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev not available' },
    );
    // Seed studies so preview mode has data to show
    await browser.execute(() => window.__ppDev.seedStudies(5));
    await browser.pause(200);
    // Reload popup so it picks up the seeded studies from IndexedDB
    await browser.url(POPUP_URL);
    await browser.pause(500);
  });

  it('captures settings panel with filter expanded (all new fields)', async () => {
    await navigateToSettings();
    await addFilter();
    await browser.pause(200);

    // Enable quiet hours, desktop notify, dry run, and set study type filter
    await browser.execute(() => {
      const quietToggle = document.querySelector('[aria-label="Enable quiet hours"]');
      if (quietToggle && !quietToggle.checked) quietToggle.click();
      const desktopToggle = document.querySelector('[aria-label="Send desktop notification"]');
      if (desktopToggle && !desktopToggle.checked) desktopToggle.click();
      const testModeToggle = document.querySelector('[aria-label="Test mode"]');
      if (testModeToggle && !testModeToggle.checked) testModeToggle.click();
      // Set Min ETA to 5
      const minEtaInput = document.querySelector('[id^="priorityMinEtaInput-"]');
      if (minEtaInput) { minEtaInput.value = '5'; minEtaInput.dispatchEvent(new Event('input', { bubbles: true })); }
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

  it('captures filter lower half (study types, dry run, preview)', async () => {
    // Uncheck "Ongoing" study type so the restriction hint shows
    await browser.execute(() => {
      const labels = document.querySelectorAll('.flex.items-center.gap-1.cursor-pointer');
      const ongoingLabel = Array.from(labels).find(l => l.textContent.includes('Ongoing'));
      if (ongoingLabel) { const cb = ongoingLabel.querySelector('input'); if (cb) cb.click(); }
    });
    await browser.pause(200);

    // Scroll the study types section into view
    await browser.execute(() => {
      const labels = document.querySelectorAll('.flex.items-center.gap-1.cursor-pointer');
      const stdLabel = Array.from(labels).find(l => l.textContent.includes('Standard'));
      if (stdLabel) stdLabel.scrollIntoView({ block: 'start' });
    });
    await browser.pause(100);

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await browser.pause(100);
      await screenshot(`settings-filter-lower-${theme}`);
    }
  });

  it('captures filter with preview expanded', async () => {
    // Click the preview button to expand the match preview
    await browser.execute(() => {
      const btns = document.querySelectorAll('.border-t button');
      const previewBtn = Array.from(btns).find(b => b.textContent.includes('studies match'));
      if (previewBtn) previewBtn.click();
    });
    await browser.pause(200);

    // Scroll the preview section into view
    await browser.execute(() => {
      const btns = document.querySelectorAll('.border-t button');
      const previewBtn = Array.from(btns).find(b => b.textContent.includes('studies match'));
      if (previewBtn) previewBtn.scrollIntoView({ block: 'start' });
    });
    await browser.pause(100);

    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await browser.pause(100);
      await screenshot(`settings-filter-preview-${theme}`);
    }
  });

  it('captures collapsed filter badges (with new criteria badges)', async () => {
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
