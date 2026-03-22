import fs from 'node:fs';
import {
  FIREFOX_PREFS,
  PROFILE_DIR,
  PROLIFIC_STUDIES_URL,
} from './helpers/constants.js';
import { GoServerManager } from './helpers/go-server.js';
import { zipExtensionBase64 } from './helpers/extension.js';
import { isLoggedIn, automatedLogin } from './helpers/auth.js';

const headless = process.env.HEADLESS === '1';
const skipSlow = process.env.SKIP_SLOW === '1';
const loginTimeout = 300_000; // 5 minutes
const loginPollInterval = 3_000;

// Ensure profile directory exists
fs.mkdirSync(PROFILE_DIR, { recursive: true });

export const config = {
  runner: 'local',
  specs: [[
    './specs/01-server-health.js',
    './specs/02-popup-display.js',
    './specs/03-popup-tabs.js',
    './specs/04-server-reconnect.js',
    './specs/05-settings.js',
    './specs/06-studies-intercept.js',
    './specs/07-debug-state.js',
  ]],
  maxInstances: 1,

  capabilities: [{
    browserName: 'firefox',
    'moz:firefoxOptions': {
      args: [
        '-profile', PROFILE_DIR,
        ...(headless ? ['-headless'] : []),
      ],
      prefs: FIREFOX_PREFS,
    },
  }],

  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000,
    ...(skipSlow ? { grep: /^(?!.*@slow)/ } : {}),
  },

  async before() {
    // Build and start Go server in the worker process so the reconnection
    // test can stop/restart it via browser.goServer.
    const goServer = new GoServerManager();
    console.log('Building Go server...');
    goServer.build();
    console.log('Starting Go server...');
    goServer.start();
    await goServer.waitHealthy();
    console.log('Go server is healthy.');

    // Store goServer reference for reconnection test and cleanup
    browser.goServer = goServer;

    // Install extension
    console.log('Installing extension...');
    const xpiBase64 = await zipExtensionBase64();
    await browser.installAddOn(xpiBase64, true);
    console.log('Extension installed.');

    // Wait for extension to initialize
    await browser.pause(3000);

    // Handle login
    if (!(await isLoggedIn())) {
      console.log('Not logged in to Prolific. Attempting automated login...');
      if (!(await automatedLogin())) {
        if (headless) {
          throw new Error(
            'Not logged in and running headless. Run setup-login.js first.',
          );
        }
        console.log(
          `Automated login failed. Please log in manually.\n` +
          `Waiting up to ${loginTimeout / 1000}s for login...`,
        );
        const deadline = Date.now() + loginTimeout;
        let loggedIn = false;
        while (Date.now() < deadline) {
          await browser.pause(loginPollInterval);
          if (await isLoggedIn()) {
            loggedIn = true;
            break;
          }
        }
        if (!loggedIn) {
          throw new Error('Login timed out after 5 minutes');
        }
      }
      console.log('Logged in to Prolific successfully.');
    }

    // Navigate to studies to trigger extension token interception
    await browser.url(PROLIFIC_STUDIES_URL);
    await browser.pause(3000);
    console.log('Prolific studies page loaded for token sync.');
  },

  async after() {
    if (browser.goServer) {
      await browser.goServer.stop();
      console.log('Go server stopped.');
    }
  },
};
