import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CHROME_EXTENSION_OUTPUT_DIR, PROFILE_DIR } from './constants.js';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
export const CHROME_EXTENSION_DIR = path.join(__dirname, '..', '.chrome-extension');

/**
 * Prepare a Chrome-compatible extension directory by copying from
 * WXT's Chrome build output (already has the correct manifest).
 */
export function prepareChromeExtensionDir() {
  if (fs.existsSync(CHROME_EXTENSION_DIR)) {
    fs.rmSync(CHROME_EXTENSION_DIR, { recursive: true });
  }
  fs.cpSync(CHROME_EXTENSION_OUTPUT_DIR, CHROME_EXTENSION_DIR, { recursive: true });
}


/**
 * Load Prolific session cookies into a Chrome WebDriver session.
 *
 * Prefers a *fresh* .chrome-cookies.json (saved by setup-login-chrome.py via nodriver) which contains
 * Chrome-native cookies that best pass Cloudflare validation. When that file is missing, unreadable,
 * or STALE (its auth0 session cookies have expired), falls back to the live Firefox profile session —
 * which is kept fresh by `node setup-login.js` and is what the Firefox e2e already uses — so a
 * long-untouched Chrome cookie dump no longer silently breaks the whole Chrome run.
 *
 * Returns the number of cookies injected.
 */
export async function loadCookiesForChrome(br) {
  const chromeCookies = path.join(__dirname, '..', '.chrome-cookies.json');
  if (fs.existsSync(chromeCookies) && !chromeCookiesAreStale(chromeCookies)) {
    const injected = await injectCookiesFromJSON(br, chromeCookies);
    if (injected > 0) return injected;
  }
  return injectCookiesFromFirefox(br);
}

/**
 * A .chrome-cookies.json is stale when it carries no live auth0 session cookie — the `auth0`/
 * `auth0_compat` cookies are what actually authenticate, so if they're absent or all expired the dump
 * can't log us in and we should fall back to the Firefox session instead.
 */
function chromeCookiesAreStale(cookiesPath) {
  try {
    const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
    const nowSec = Date.now() / 1000;
    const authCookies = cookies.filter((c) => /^auth0/.test(c.name || ''));
    if (authCookies.length === 0) return true;
    return authCookies.every((c) => {
      const exp = Number(c.expires ?? c.expiry ?? 0);
      return exp > 0 && exp < nowSec;
    });
  } catch {
    return true;
  }
}

async function injectCookiesFromJSON(br, cookiesPath) {
  let cookies;
  try {
    cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
  } catch {
    return 0;
  }

  const domains = new Set(cookies.map((c) => {
    const d = (c.domain || '').replace(/^\./, '');
    return d.includes('prolific') ? `https://${d}` : null;
  }).filter(Boolean));

  let injected = 0;
  for (const origin of domains) {
    await br.url(origin);
    await br.pause(1000);
    const originHost = new URL(origin).hostname;
    const matching = cookies.filter((c) => {
      const cookieDomain = (c.domain || '').replace(/^\./, '');
      return cookieDomain === originHost;
    });
    for (const c of matching) {
      try {
        await br.setCookies([c]);
        injected++;
      } catch { /* rejected */ }
    }
  }
  return injected;
}

async function injectCookiesFromFirefox(br) {
  const cookiesDb = path.join(PROFILE_DIR, 'cookies.sqlite');
  if (!fs.existsSync(cookiesDb)) return 0;

  let rows;
  try {
    const raw = execSync(
      `sqlite3 -json "${cookiesDb}" "SELECT name,value,host,path,isSecure,isHttpOnly,expiry FROM moz_cookies WHERE host LIKE '%prolific%'"`,
    ).toString();
    rows = JSON.parse(raw);
  } catch {
    return 0;
  }

  const origins = [
    'https://app.prolific.com',
    'https://auth.prolific.com',
  ];

  let injected = 0;
  for (const origin of origins) {
    await br.url(origin);
    await br.pause(1000);
    const pageHost = new URL(await br.getUrl()).hostname;
    // Match cookies whose domain is the page host OR a parent domain
    // (e.g. .prolific.com cookies are valid on app.prolific.com)
    const matching = rows.filter((r) => {
      const cookieHost = r.host.replace(/^\./, '');
      return cookieHost === pageHost || pageHost.endsWith('.' + cookieHost);
    });
    for (const c of matching) {
      try {
        const cookie = {
          name: c.name, value: c.value, domain: c.host,
          path: c.path, secure: !!c.isSecure, httpOnly: !!c.isHttpOnly,
        };
        const exp = Number(c.expiry);
        if (exp > 0) {
          cookie.expiry = exp > 2000000000 ? Math.floor(exp / 1000) : exp;
        }
        await br.setCookies([cookie]);
        injected++;
      } catch { /* rejected */ }
    }
  }
  return injected;
}

