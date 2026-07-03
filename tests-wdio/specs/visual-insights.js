// Visual audit for issue #19: study-history Insights panel.
// Seeds studies (which now also seed studiesHistory with reward moves + rerun/availability events),
// then screenshots the Insights tab (light + dark) so the four analyses can be eyeballed.
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

async function seedStudies(count) {
  return browser.executeAsync((n, done) => {
    const run = async () => {
      if (!window.__ppDev) { done({ error: 'no __ppDev' }); return; }
      const seeded = await window.__ppDev.seedStudies(n);
      done({ seeded });
    };
    run().catch((e) => done({ error: String(e) }));
  }, count);
}

async function clearAll() {
  // wipeStudyData clears ALL study tables (incl. any real events captured by the e2e specs into this
  // shared login profile), so the seeded Insights demo is deterministic and not polluted.
  await browser.executeAsync((done) => {
    if (!window.__ppDev) { done(); return; }
    Promise.allSettled([window.__ppDev.clear(), window.__ppDev.wipeStudyData()]).then(() => done());
  });
}

async function navigateTo(tab) {
  await browser.execute((t) => {
    document.querySelector(`button[data-tab="${t}"]`)?.click();
  }, tab);
  await browser.pause(150);
}

async function screenshot(name) {
  const filePath = path.join(OUT_DIR, `${name}.png`);
  await browser.saveScreenshot(filePath);
  console.log(`  saved: ${filePath}`);
}

describe('Visual: Study-history Insights (issue #19)', () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seedStudies === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev.seedStudies not available' },
    );
    try { await browser.setWindowRect(0, 0, 640, 900); }
    catch { try { await browser.setWindowSize(640, 900); } catch { /* ignore */ } }
    await clearAll();
    const res = await seedStudies(40);
    console.log('  seeded studies:', JSON.stringify(res));
    await browser.url(POPUP_URL);
    await browser.pause(400);
  });

  it('insights panel (light)', async () => {
    await navigateTo('insights');
    // Wait for the async insights load to resolve into rendered sections.
    await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('#panelInsights section')),
      { timeout: 5000, interval: 100, timeoutMsg: 'insights sections never rendered' },
    );
    await setTheme('light');
    await browser.pause(200);
    await screenshot('insights-light');
  });

  it('insights panel scrolled to posting chart + reruns (light)', async () => {
    await setTheme('light');
    await browser.execute(() => {
      const el = document.querySelector('#panelInsights .scroll-container');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await browser.pause(250);
    await screenshot('insights-light-lower');
  });

  it('insights panel (dark)', async () => {
    await browser.execute(() => {
      const el = document.querySelector('#panelInsights .scroll-container');
      if (el) el.scrollTop = 0;
    });
    await setTheme('dark');
    await browser.pause(200);
    await screenshot('insights-dark');
  });

  it('insights panel — sporadic-usage data-quality note (light)', async () => {
    // Re-seed the sparse (gappy) case: studies seen once, gone after a multi-day gap.
    await clearAll();
    await browser.executeAsync((done) => {
      window.__ppDev.seedSparseStudies(8).then((n) => done(n)).catch((e) => done(String(e)));
    });
    await browser.url(POPUP_URL);
    await browser.pause(400);
    await navigateTo('insights');
    await browser.waitUntil(
      async () => browser.execute(() => !!document.querySelector('#panelInsights .insights, #panelInsights .border-dashed')),
      { timeout: 5000, interval: 100, timeoutMsg: 'insights never rendered' },
    );
    await setTheme('light');
    await browser.pause(200);
    await screenshot('insights-sparse-light');
  });

  after(async () => {
    await clearAll();
  });
});
