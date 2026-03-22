import fs from 'node:fs';
import { AUTH_FILE, PROLIFIC_APP_URL, PROLIFIC_AUTH_HOST } from './constants.js';

/**
 * Parse .prolific-auth file for email/password credentials.
 */
export function parseAuthFile() {
  const creds = {};
  if (!fs.existsSync(AUTH_FILE)) return creds;
  const lines = fs.readFileSync(AUTH_FILE, 'utf8').trim().split('\n');
  for (const line of lines) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    creds[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return creds;
}

/**
 * Wait for page URL to stabilize (redirects/challenges to finish).
 * @param {object} [b] - Browser instance. Defaults to the WDIO global `browser`.
 */
export async function waitForNavigation(b, timeout = 30_000) {
  const br = b || browser;
  const deadline = Date.now() + timeout;
  let prevUrl = await br.getUrl();
  let stableCount = 0;
  while (Date.now() < deadline) {
    await br.pause(1000);
    const url = await br.getUrl();
    if (url === prevUrl) {
      stableCount++;
      if (stableCount >= 3) return url;
    } else {
      stableCount = 0;
      prevUrl = url;
    }
  }
  return br.getUrl();
}

/**
 * Check if Prolific session is active.
 */
export async function isLoggedIn() {
  await browser.url(PROLIFIC_APP_URL);
  const url = await waitForNavigation(undefined);
  console.log(`  Login check — final URL: ${url}`);

  if (url.includes(PROLIFIC_AUTH_HOST)) return false;
  if (!url.includes('app.prolific.com')) {
    console.log('  Not on Prolific app (Cloudflare challenge?)');
    return false;
  }

  try {
    const root = await $('nav, [data-testid], .studies-list, #root > div');
    await root.waitForDisplayed({ timeout: 10_000 });
    return true;
  } catch {
    console.log('  No Prolific app content found after navigation');
    return false;
  }
}

/**
 * Attempt automated login using credentials from .prolific-auth.
 */
export async function automatedLogin() {
  const creds = parseAuthFile();
  if (!creds.email || !creds.password) {
    console.log('  No credentials in .prolific-auth');
    return false;
  }

  console.log(`  Logging in as ${creds.email}...`);
  try {
    const username = await $('#username');
    await username.waitForDisplayed({ timeout: 15_000 });
    await username.setValue(creds.email);
    await (await $('#password')).setValue(creds.password);
    await (await $('button[type="submit"]')).click();

    await browser.waitUntil(
      async () => {
        const url = await browser.getUrl();
        return url.startsWith(PROLIFIC_APP_URL);
      },
      { timeout: 30_000 },
    );
    await browser.pause(3000);

    const url = await browser.getUrl();
    const loggedIn = !url.includes(PROLIFIC_AUTH_HOST);
    console.log(loggedIn ? '  Login successful.' : `  Still on auth page: ${url}`);
    return loggedIn;
  } catch (e) {
    console.log(`  Automated login failed: ${e.message}`);
    return false;
  }
}
