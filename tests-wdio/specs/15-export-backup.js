// E2E for the data export & backup feature (issue #23), on the full-page app.
// Dev build, no login. Drives the real UI (backup button, analytics panel,
// restore confirm) AND performs a genuine export → wipe → restore round-trip
// through __ppDev, which calls the shipped backup lib against real IndexedDB
// and real browser.storage.local. Runs under wdio.visual.conf.js.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POPUP_URL } from '../helpers/constants.js';

import { fileURLToPath } from 'node:url';

const APP_URL = POPUP_URL.replace('/popup.html', '/app.html');
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots', 'visual');

async function waitForDev() {
  await browser.waitUntil(
    async () => browser.execute(() => typeof window.__ppDev?.exportBackup === 'function'),
    { timeout: 10_000, timeoutMsg: '__ppDev.exportBackup not available' },
  );
}

async function openApp() {
  await browser.url(APP_URL);
  await waitForDev();
}

async function wipeAll() {
  await browser.executeAsync((done) => {
    (async () => {
      await window.__ppDev.clear().catch(() => {});
      await window.__ppDev.wipeStudyData().catch(() => {});
      done(true);
    })().catch(() => done(true));
  });
}

async function seedData(subs, researchers) {
  const result = await browser.executeAsync((s, r, done) => {
    (async () => {
      await window.__ppDev.clear().catch(() => {});
      await window.__ppDev.wipeStudyData().catch(() => {});
      await window.__ppDev.seed(s);
      await window.__ppDev.seedResearchers(r);
      done(await window.__ppDev.countTables());
    })().catch((e) => done({ error: String(e) }));
  }, subs, researchers);
  if (result.error) throw new Error(`seedData failed: ${result.error}`);
  return result;
}

describe('Data export & backup (issue #23)', () => {
  before(async () => {
    await browser.url(APP_URL);
    await waitForDev();
    try { await browser.setWindowRect(0, 0, 1280, 2000); } catch { /* ignore */ }
  });

  describe('UI presence', () => {
    it('shows the Backup & export card even with an empty database', async () => {
      await wipeAll();
      await openApp();
      const card = await $('#dataExportCard');
      await card.waitForExist({ timeout: 8000 });
      expect(await card.isDisplayed()).toBe(true);

      // Export buttons disabled with no submissions; backup/restore always available.
      expect(await $('#exportSubmissionsBtn').isEnabled()).toBe(false);
      expect(await $('#exportAnalyticsBtn').isEnabled()).toBe(false);
      expect(await $('#backupAllBtn').isEnabled()).toBe(true);
      expect(await $('#restoreBtn').isEnabled()).toBe(true);
    });

    it('enables the export buttons once there are submissions', async () => {
      await seedData(40, 5);
      await openApp();
      await $('#dataExportCard').waitForExist({ timeout: 8000 });
      await browser.waitUntil(async () => $('#exportSubmissionsBtn').isEnabled(), {
        timeout: 8000,
        timeoutMsg: 'export submissions button never enabled',
      });
      expect(await $('#exportAnalyticsBtn').isEnabled()).toBe(true);
    });
  });

  describe('Backup button', () => {
    it('runs a real backup and reports a success banner', async () => {
      await seedData(40, 5);
      await openApp();
      await $('#backupAllBtn').waitForClickable({ timeout: 8000 });
      await $('#backupAllBtn').click();
      const banner = await $('#exportBanner');
      await banner.waitForExist({ timeout: 8000 });
      const text = await banner.getText();
      expect(text).toContain('Backed up');
      expect(text).toMatch(/\d+ records?/);
    });
  });

  describe('Analytics export panel', () => {
    it('toggles open and gates the download button on a selection', async () => {
      await seedData(60, 4);
      await openApp();
      await $('#exportAnalyticsBtn').waitForClickable({ timeout: 8000 });
      await $('#exportAnalyticsBtn').click();
      await $('#analyticsExportPanel').waitForExist({ timeout: 4000 });
      expect(await $('#analyticsDownloadBtn').isEnabled()).toBe(true);

      // Visual artifact: the card + open analytics panel, light & dark.
      fs.mkdirSync(OUT_DIR, { recursive: true });
      await $('#dataExportCard').scrollIntoView();
      await browser.pause(200);
      await browser.execute(() => document.documentElement.setAttribute('data-theme', 'light'));
      await browser.pause(150);
      await browser.saveScreenshot(path.join(OUT_DIR, 'export-card-light.png'));
      await browser.execute(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await browser.pause(150);
      await browser.saveScreenshot(path.join(OUT_DIR, 'export-card-dark.png'));

      // Deselect every dataset → download disabled.
      const boxes = await $$('#analyticsExportPanel input[type="checkbox"]');
      for (const box of boxes) {
        if (await box.isSelected()) await box.click();
      }
      await browser.waitUntil(async () => !(await $('#analyticsDownloadBtn').isEnabled()), {
        timeout: 4000,
        timeoutMsg: 'download button did not disable when nothing selected',
      });
    });
  });

  describe('Export → wipe → restore round-trip (real lib, real IndexedDB)', () => {
    it('restores every table to its original counts', async () => {
      const before = await seedData(50, 6);
      await openApp();

      const result = await browser.executeAsync((done) => {
        (async () => {
          const json = await window.__ppDev.exportBackup();
          await window.__ppDev.clear();
          await window.__ppDev.wipeStudyData();
          const afterWipe = await window.__ppDev.countTables();
          const summary = await window.__ppDev.restoreBackup(json);
          const afterRestore = await window.__ppDev.countTables();
          done({ jsonLen: json.length, afterWipe, summary, afterRestore });
        })().catch((e) => done({ error: String(e) }));
      });
      if (result.error) throw new Error(result.error);

      expect(result.jsonLen).toBeGreaterThan(0);
      expect(result.afterWipe.submissions).toBe(0);
      expect(result.afterRestore.submissions).toBe(before.submissions);
      expect(result.afterRestore.researchers).toBe(before.researchers);
      expect(result.summary.rowsRestored).toBeGreaterThan(0);
    });
  });

  describe('Restore via the file picker (real UI)', () => {
    it('opens a confirm dialog from an uploaded backup and applies it', async () => {
      const before = await seedData(30, 3);
      await openApp();

      // Grab a real backup string and write it to a temp file for the <input type=file>.
      const exported = await browser.executeAsync((done) => {
        window.__ppDev.exportBackup().then((j) => done({ json: j })).catch((e) => done({ error: String(e) }));
      });
      if (exported.error) throw new Error(exported.error);
      const tmp = path.join(os.tmpdir(), `pp-backup-${Date.now()}.json`);
      fs.writeFileSync(tmp, exported.json, 'utf8');

      await wipeAll();

      // geckodriver won't fire `change` on a display:none input, so un-hide the
      // (still off-screen) file input just for the upload. Product code is unchanged.
      await browser.execute(() => {
        const inp = document.querySelector('#dataExportCard input[type="file"]');
        if (inp) inp.classList.remove('hidden');
      });
      const fileInput = await $('#dataExportCard input[type="file"]');
      await fileInput.addValue(tmp);

      // The confirm dialog (and its confirm button) only exist once the file parses,
      // so a clickable #confirmRestoreBtn proves the confirm UI rendered. (getText is
      // avoided here — geckodriver returns "" for off-viewport innerText.)
      const confirmBtn = await $('#confirmRestoreBtn');
      await confirmBtn.waitForClickable({ timeout: 8000 });
      expect(await $('#restoreConfirm').isExisting()).toBe(true);

      await confirmBtn.click();
      const banner = await $('#exportBanner');
      await banner.waitForExist({ timeout: 8000 });
      await banner.scrollIntoView();
      await browser.waitUntil(async () => (await banner.getText()).includes('Restored'), {
        timeout: 8000,
        timeoutMsg: 'restore success banner never showed',
      });

      const after = await browser.executeAsync((done) => {
        window.__ppDev.countTables().then((c) => done(c)).catch((e) => done({ error: String(e) }));
      });
      expect(after.submissions).toBe(before.submissions);

      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    });
  });
});
