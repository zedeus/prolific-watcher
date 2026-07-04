import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { SHARED_SPECS, SHARED_CONFIG, sharedBefore, sharedAfter } from './helpers/shared-setup.js';
import {
  prepareChromeExtensionDir,
  loadCookiesForChrome,
  CHROME_EXTENSION_DIR,
} from './helpers/chrome-extension.js';

const headless = process.env.HEADLESS === '1';
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CHROME_PROFILE_DIR = path.join(__dirname, '..', 'tests', 'profiles', 'prolific-chrome');

function findChromeBinary() {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  try {
    const found = execSync(`ls -1 ${process.env.HOME}/tmp/prolific-pulse/cft/chrome/*/chrome-linux64/chrome /tmp/cft/chrome/*/chrome-linux64/chrome 2>/dev/null | tail -1`)
      .toString().trim();
    if (found) return found;
  } catch { /* not found */ }
  return '/usr/bin/google-chrome-stable';
}

// Prefer a locally-installed chromedriver (must match the CfT Chrome above) so runs don't depend on
// wdio auto-downloading a driver — which mis-targets the latest version rather than the pinned CfT one.
// Returns null when none is found, letting wdio fall back to its automated driver management (e.g. CI).
function findChromedriverBinary() {
  if (process.env.CHROMEDRIVER_BINARY) return process.env.CHROMEDRIVER_BINARY;
  try {
    const found = execSync(`ls -1 ${process.env.HOME}/tmp/prolific-pulse/cft/chromedriver*/chromedriver-linux64/chromedriver /tmp/cft/chromedriver*/chromedriver-linux64/chromedriver 2>/dev/null | tail -1`)
      .toString().trim();
    if (found) return found;
  } catch { /* not found */ }
  return null;
}

// Chrome loads the extension at browser start via --load-extension, so the
// build must finish BEFORE prepareChromeExtensionDir copies the output.
// (sharedBefore's build runs too late — Chrome is already up by then.)
console.log('Building extension with WXT for chrome...');
execSync('npx wxt build -b chrome', { cwd: path.join(__dirname, '..', 'src'), stdio: 'inherit' });
console.log('Extension built.');

prepareChromeExtensionDir();
fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });

// Chrome caches the service worker script between runs. If the extension code
// changed, the old SW stays active and the new background.js never loads. Nuke
// the SW cache so Chrome picks up the fresh build on startup.
const swCacheDir = path.join(CHROME_PROFILE_DIR, 'Default', 'Service Worker');
if (fs.existsSync(swCacheDir)) {
  fs.rmSync(swCacheDir, { recursive: true });
}

const chromedriverBinary = findChromedriverBinary();

export const config = {
  ...SHARED_CONFIG,
  specs: SHARED_SPECS,

  capabilities: [{
    browserName: 'chrome',
    // Use the classic WebDriver protocol. wdio v9 defaults to BiDi, but chromedriver's BiDi
    // storage.setCookie rejects our injected Prolific cookies and floods every run with
    // "BiDi setCookies failed, falling back to classic" warnings (two attempts per cookie). The
    // extension specs only use classic commands, so enforcing classic is cleaner and faster.
    'wdio:enforceWebDriverClassic': true,
    'goog:chromeOptions': {
      binary: findChromeBinary(),
      args: [
        `--load-extension=${CHROME_EXTENSION_DIR}`,
        `--user-data-dir=${CHROME_PROFILE_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-search-engine-choice-screen',
        // Needed for Chrome to start in sandboxed/containerised runners without a "tab crashed" on the
        // first session (no user namespaces, small /dev/shm). Harmless for a throwaway test browser.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        ...(headless ? ['--headless=new', '--disable-gpu'] : []),
      ],
      excludeSwitches: ['disable-extensions'],
    },
    ...(chromedriverBinary ? { 'wdio:chromedriverOptions': { binary: chromedriverBinary } } : {}),
  }],

  async before() {
    await sharedBefore({
      async beforeLogin() {
        const injected = await loadCookiesForChrome(browser);
        if (injected > 0) {
          console.log(`Injected ${injected} session cookies.`);
        }
      },
    });
  },

  after: sharedAfter,
};
