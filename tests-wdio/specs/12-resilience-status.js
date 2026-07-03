// Issue #25 — visual + smoke coverage of the backend-resilience recovery states surfaced in the
// StatusBar. Seeds the popup-facing sync state via __ppDev.seedSyncState (no live background needed
// for the seed) and captures screenshots for human review. Assertions are deliberately tolerant of
// the dev build's live background (which rewrites syncState ~1×/min): they check that a recovery
// state renders an error line + a red sync dot, while the exact wording is pinned deterministically
// by the format.test.ts unit tests.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POPUP_URL } from '../helpers/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'screenshots', 'visual');

// Must match src/lib/constants.ts exactly (em dash + ellipsis are intentional).
const RECONNECTING = 'Prolific session expired — reconnecting…';
const PERSISTENT = "Studies aren't updating. Check your connection, or reload the Prolific tab.";

const SCENARIOS = [
  {
    name: 'reconnecting',
    patch: { token_ok: true, studies_refresh_ok: false, studies_refresh_reason: RECONNECTING, studies_refresh_recovery_active: false },
  },
  {
    name: 'persistent-stall',
    patch: {
      token_ok: true,
      studies_refresh_ok: false,
      studies_refresh_reason: PERSISTENT,
      studies_refresh_recovery_active: true,
      studies_refresh_consecutive_failures: 4,
    },
  },
];

async function setTheme(theme) {
  await browser.execute((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

async function seedState(patch) {
  await browser.executeAsync((p, done) => {
    if (!window.__ppDev?.seedSyncState) { done({ error: 'no seedSyncState' }); return; }
    window.__ppDev.seedSyncState(p).then(() => done({ ok: true })).catch((e) => done({ error: String(e) }));
  }, patch);
}

async function seedStudies(count) {
  await browser.executeAsync((n, done) => {
    if (!window.__ppDev?.seedStudies) { done(); return; }
    window.__ppDev.seedStudies(n).then(() => done()).catch(() => done());
  }, count);
}

async function screenshot(name) {
  await browser.saveScreenshot(path.join(OUT_DIR, `${name}.png`));
}

async function readStatus() {
  return browser.execute(() => {
    const err = document.querySelector('#errorMessage');
    const dot = document.querySelector('#syncDot');
    return {
      errorText: err ? (err.textContent || '').trim() : null,
      errorHidden: err ? err.classList.contains('hidden') : true,
      dotBad: dot ? dot.classList.contains('bad') : false,
    };
  });
}

describe('Issue #25: resilience recovery states', () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await browser.url(POPUP_URL);
    await browser.waitUntil(
      async () => browser.execute(() => typeof window.__ppDev?.seedSyncState === 'function'),
      { timeout: 10_000, timeoutMsg: '__ppDev.seedSyncState not available' },
    );
    await seedStudies(8); // give the panels content behind the status bar
    try { await browser.setWindowRect(0, 0, 620, 700); } catch { /* ignore */ }
  });

  for (const scenario of SCENARIOS) {
    describe(scenario.name, () => {
      beforeEach(async () => {
        await seedState(scenario.patch);
        await browser.url(POPUP_URL); // remount reads the freshly-seeded state
        await browser.pause(400);
      });

      it('renders a recovery error line with a red sync dot', async () => {
        // Tolerant of the live background: assert an error state renders (exact copy is unit-pinned).
        const status = await browser.waitUntil(
          async () => {
            const s = await readStatus();
            return s.errorText && s.errorText.length > 0 && s.dotBad ? s : false;
          },
          { timeout: 4000, timeoutMsg: `no recovery error line rendered for ${scenario.name}`, interval: 200 },
        );
        expect(status.dotBad).toBe(true);
        expect(status.errorText.length).toBeGreaterThan(0);
      });

      it(`screenshots ${scenario.name} (light + dark)`, async () => {
        await setTheme('light');
        await browser.pause(150);
        await screenshot(`resilience-${scenario.name}-light`);
        await setTheme('dark');
        await browser.pause(150);
        await screenshot(`resilience-${scenario.name}-dark`);
      });
    });
  }
});
