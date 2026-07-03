/**
 * Shared test setup used by both Firefox and Chrome WDIO configs.
 *
 * Each browser config provides capabilities and an optional
 * `installExtension` callback. Everything else — popup URL discovery,
 * login, token sync — is identical.
 */

import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROLIFIC_STUDIES_URL, POPUP_URL, WXT_SRC_DIR } from './constants.js';
import { isLoggedIn, automatedLogin } from './auth.js';
import { CHROME_EXTENSION_DIR } from './chrome-extension.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const headless = process.env.HEADLESS === '1';
const skipSlow = process.env.SKIP_SLOW === '1';
const loginTimeout = 300_000;
const loginPollInterval = 3_000;

export const SHARED_SPECS = [[
  './specs/01-extension-health.js',
  './specs/02-popup-display.js',
  './specs/03-popup-tabs.js',
  './specs/04-extension-resilience.js',
  './specs/05-settings.js',
  './specs/06-studies-intercept.js',
  './specs/07-debug-state.js',
  './specs/08-popup-panels.js',
  './specs/09-screenshots.js',
  './specs/10-researcher-lists.js',
]];

export const SHARED_CONFIG = {
  runner: 'local',
  maxInstances: 1,
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: skipSlow ? 120_000 : 180_000,
    ...(skipSlow ? { grep: /^(?!.*@slow)/ } : {}),
  },
};

/**
 * Discover the extension popup URL.
 * For Firefox, the UUID is pre-seeded so we use the deterministic URL.
 * For Chrome, we derive it from the extension ID in capabilities or
 * fall back to polling the popup URL until it responds.
 */
async function discoverPopupUrl() {
  const browserName = browser.capabilities?.browserName || 'firefox';

  if (browserName !== 'chrome') {
    // Firefox: deterministic URL from pre-seeded UUID
    return POPUP_URL;
  }

  // Chrome: the extension ID isn't known ahead of time (no manifest key), and `chrome.runtime` is not
  // exposed in a page's MAIN world — so `browser.execute(() => chrome.runtime.getURL(...))` always
  // returns null and the old code silently fell back to the *Firefox* moz-extension URL (blank in
  // Chrome). For an unpacked extension Chrome derives the ID deterministically from the SHA-256 of the
  // absolute load path, so we compute it directly (no CDP/service-worker timing to race).
  return `chrome-extension://${chromeUnpackedExtensionId(CHROME_EXTENSION_DIR)}/popup.html`;
}

/**
 * Compute the ID Chrome assigns to an unpacked extension loaded from `absPath`: SHA-256 the absolute
 * path, take the first 16 bytes (32 hex nibbles), and map each nibble 0–f to a–p. Deterministic and
 * matches Chrome's own algorithm, so the resulting chrome-extension://<id>/ URL is stable per path.
 */
export function chromeUnpackedExtensionId(absPath) {
  const hex = crypto.createHash('sha256').update(absPath, 'utf8').digest('hex').slice(0, 32);
  return hex.split('').map((nibble) => String.fromCharCode(97 + parseInt(nibble, 16))).join('');
}

/**
 * Shared before hook.
 *
 * @param {object} opts
 * @param {() => Promise<void>} [opts.installExtension]
 *   Browser-specific extension installation (e.g. Firefox installAddOn).
 *   Omit if the extension is loaded via capabilities (Chrome).
 * @param {() => Promise<void>} [opts.beforeLogin]
 *   Runs after extension connects but before the login check.
 *   Used by Chrome to inject session cookies from the Firefox profile.
 */
export async function sharedBefore(opts = {}) {
  // Build extension with WXT for both browsers.
  const browserName = browser.capabilities?.browserName || 'firefox';
  const wxtTarget = browserName === 'chrome' ? 'chrome' : 'firefox';
  console.log(`Building extension with WXT for ${wxtTarget}...`);
  execSync(`npx wxt build -b ${wxtTarget}`, { cwd: WXT_SRC_DIR, stdio: 'inherit' });
  console.log('Extension built.');

  // Browser-specific extension installation (Firefox).
  if (opts.installExtension) {
    await opts.installExtension();
  }

  // Discover popup URL.
  console.log('Discovering popup URL...');
  const popupUrl = await discoverPopupUrl();
  browser.popupUrl = popupUrl;
  console.log(`Popup URL: ${popupUrl}`);

  // Browser-specific pre-login hook (Chrome cookie injection).
  if (opts.beforeLogin) {
    await opts.beforeLogin();
  }

  // Handle login.
  if (!(await isLoggedIn())) {
    if (headless) {
      const browser_ = browser.capabilities?.browserName || 'browser';
      const hint = browser_ === 'chrome'
        ? 'Run: cd tests-wdio && .venv/bin/python setup-login-chrome.py'
        : 'Run: cd tests-wdio && node setup-login.js';
      throw new Error(
        `Not logged in to Prolific (session cookies expired?).\n${hint}`,
      );
    }
    console.log('Not logged in. Attempting automated login...');
    if (!(await automatedLogin())) {
      console.log(
        `Automated login failed. Please log in manually.\n` +
        `Waiting up to ${loginTimeout / 1000}s for login...`,
      );
      const deadline = Date.now() + loginTimeout;
      let loggedIn = false;
      while (Date.now() < deadline) {
        await browser.pause(loginPollInterval);
        if (await isLoggedIn()) { loggedIn = true; break; }
      }
      if (!loggedIn) throw new Error('Login timed out after 5 minutes');
    }
    console.log('Logged in to Prolific successfully.');
  }

  // Navigate to studies to trigger token interception.
  await browser.url(PROLIFIC_STUDIES_URL);
  await browser.pause(5000);
  console.log('Prolific studies page loaded for token sync.');

  // Verify token sync by checking popup status dot.
  const syncDeadline = Date.now() + 20_000;
  let synced = false;
  while (Date.now() < syncDeadline) {
    try {
      await browser.url(popupUrl);
      await (await $('#syncDot')).waitForDisplayed({ timeout: 3000 });
      const dotBad = await browser.execute(() => {
        const dot = document.getElementById('syncDot');
        return dot ? dot.classList.contains('bad') : true;
      });
      if (!dotBad) { synced = true; break; }
    } catch { /* retry */ }
    await browser.url(PROLIFIC_STUDIES_URL);
    await browser.pause(3000);
  }
  if (synced) {
    console.log('Extension token sync verified.');
  } else {
    console.log('WARNING: Token sync not confirmed within 20s.');
  }
}

export async function sharedAfter() {
  // No server to stop — all data is in the extension's IndexedDB.
}
