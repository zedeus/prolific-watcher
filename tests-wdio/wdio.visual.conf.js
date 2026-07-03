/**
 * Minimal visual-audit config. Builds and installs the extension, then runs
 * the screenshot spec. Skips the Prolific login / token-sync flow from the
 * main config — these tests only exercise the extension's own UI with
 * fake data, so no live session is needed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { FIREFOX_PREFS, PROFILE_DIR, WXT_SRC_DIR } from './helpers/constants.js';
import { zipExtensionBase64Dev } from './helpers/extension.js';

const headless = process.env.HEADLESS !== '0';

fs.mkdirSync(PROFILE_DIR, { recursive: true });

export const config = {
  runner: 'local',
  maxInstances: 1,
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 180_000 },

  specs: [
    path.resolve('./specs/visual-earnings.js'),
    path.resolve('./specs/visual-earnings-popup.js'),
    path.resolve('./specs/visual-live.js'),
    path.resolve('./specs/visual-researcher.js'),
    path.resolve('./specs/visual-insights.js'),
    path.resolve('./specs/11-earnings-assertions.js'),
    path.resolve('./specs/12-resilience-status.js'),
  ],

  capabilities: [{
    browserName: 'firefox',
    'moz:firefoxOptions': {
      args: [
        '-profile', PROFILE_DIR,
        '-width', '1440',
        '-height', '3400',
        ...(headless ? ['-headless'] : []),
      ],
      prefs: FIREFOX_PREFS,
    },
  }],

  async before() {
    console.log('Building extension with WXT (firefox, dev mode for __ppDev helpers)...');
    execSync('npx wxt build -b firefox --mode development', { cwd: WXT_SRC_DIR, stdio: 'inherit' });
    console.log('Installing extension...');
    const xpiBase64 = await zipExtensionBase64Dev();
    await browser.installAddOn(xpiBase64, true);
    await browser.pause(1500);
  },
};
