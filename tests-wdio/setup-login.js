#!/usr/bin/env node
/**
 * Standalone script to log in to Prolific and save the session profile.
 *
 * Usage:
 *   cd tests-wdio && node setup-login.js
 *
 * Opens a headed Firefox browser with the extension loaded.
 * Attempts automated login using credentials from .prolific-auth.
 * If automated login fails, waits for manual login.
 * Press Ctrl+C when done — the profile is saved automatically.
 */

import fs from 'node:fs';
import { remote } from 'webdriverio';
import {
  FIREFOX_PREFS,
  PROFILE_DIR,
  PROLIFIC_APP_URL,
  PROLIFIC_AUTH_HOST,
} from './helpers/constants.js';
import { parseAuthFile, waitForNavigation } from './helpers/auth.js';
import { zipExtensionBase64 } from './helpers/extension.js';

// Ensure profile directory exists before first run
fs.mkdirSync(PROFILE_DIR, { recursive: true });

async function attemptLogin(br) {
  const creds = parseAuthFile();
  if (!creds.email || !creds.password) {
    console.log('No credentials found in .prolific-auth');
    return false;
  }

  console.log(`Attempting automated login with ${creds.email}...`);
  try {
    const username = await br.$('#username');
    await username.waitForDisplayed({ timeout: 10_000 });
    await username.setValue(creds.email);
    await (await br.$('#password')).setValue(creds.password);
    await (await br.$('button[type="submit"]')).click();

    await br.waitUntil(
      async () => (await br.getUrl()).startsWith(PROLIFIC_APP_URL),
      { timeout: 30_000 },
    );
    await br.pause(2000);

    const url = await br.getUrl();
    if (!url.includes(PROLIFIC_AUTH_HOST)) {
      console.log('Automated login succeeded!');
      return true;
    }
    console.log('Automated login did not redirect to app.prolific.com');
    return false;
  } catch (e) {
    console.log(`Automated login failed: ${e.message}`);
    return false;
  }
}

async function main() {
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log();

  const br = await remote({
    capabilities: {
      browserName: 'firefox',
      'moz:firefoxOptions': {
        args: ['-profile', PROFILE_DIR],
        prefs: FIREFOX_PREFS,
      },
    },
    logLevel: 'warn',
  });

  try {
    const xpiBase64 = await zipExtensionBase64();
    await br.installAddOn(xpiBase64, true);
    console.log('Extension installed.');
    await br.pause(2000);

    await br.url(PROLIFIC_APP_URL);
    await br.pause(2000);

    const url = await waitForNavigation(br);

    if (!url.includes(PROLIFIC_AUTH_HOST)) {
      console.log('Already logged in! Profile has a valid session.');
      console.log('Press Ctrl+C to close the browser.');
    } else {
      if (!(await attemptLogin(br))) {
        console.log();
        console.log('Please log in manually in the browser window.');
        console.log('Press Ctrl+C when done.');
        console.log();
      }
    }

    // Keep browser open until Ctrl+C
    await new Promise((resolve) => {
      process.on('SIGINT', resolve);
      process.on('SIGTERM', resolve);
    });
  } finally {
    await br.deleteSession();
  }

  console.log();
  console.log(`Profile saved to: ${PROFILE_DIR}`);
  console.log('You can now run tests with: npx wdio run wdio.conf.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
