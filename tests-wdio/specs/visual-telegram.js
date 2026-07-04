import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { POPUP_URL } from '../helpers/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'screenshots', 'visual');

async function setTheme(theme) {
  await browser.execute((t) => document.documentElement.setAttribute('data-theme', t), theme);
}

async function navigateToSettings() {
  await browser.execute(() => {
    const tab = document.querySelector('button[data-tab="settings"]');
    if (tab) tab.click();
  });
  await browser.pause(150);
}

async function expandTelegram() {
  await browser.execute(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(
      (b) => /Show settings|Hide settings/.test(b.textContent) && b.closest('.setting-card')?.textContent.includes('Telegram'),
    );
    if (btn && /Show settings/.test(btn.textContent)) btn.click();
  });
  await browser.pause(200);
}

// Set every message-format checkbox to `on`, then screenshot; the checkboxes live under
// "Message includes" in the Telegram card.
async function setFormat(includeDescription) {
  await browser.execute((desc) => {
    const card = Array.from(document.querySelectorAll('.setting-card')).find((c) => c.textContent.includes('Telegram notifications'));
    if (!card) return;
    const boxes = Array.from(card.querySelectorAll('.grid input.checkbox'));
    // labels order matches tgFormatOptions: reward, hourly, duration, places, researcher, tags, description, link
    const wantOn = [true, true, true, true, true, true, desc, true];
    boxes.forEach((box, i) => {
      const want = wantOn[i] ?? true;
      if (box.checked !== want) box.click();
    });
  }, includeDescription);
  await browser.pause(200);
}

async function setMinimal() {
  await browser.execute(() => {
    const card = Array.from(document.querySelectorAll('.setting-card')).find((c) => c.textContent.includes('Telegram notifications'));
    if (!card) return;
    const boxes = Array.from(card.querySelectorAll('.grid input.checkbox'));
    // Only reward on; everything else off (including the Open study button).
    const wantOn = [true, false, false, false, false, false, false, false];
    boxes.forEach((box, i) => {
      const want = wantOn[i] ?? false;
      if (box.checked !== want) box.click();
    });
  });
  await browser.pause(200);
}

async function scrollPreviewIntoView() {
  await browser.execute(() => {
    // Scroll to the auto-update note so both it and the preview below are in frame.
    const note = Array.from(document.querySelectorAll('.setting-card span')).find((s) => /fills up or disappears/.test(s.textContent));
    const target = note?.closest('div') ?? document.querySelector('.tg-preview');
    if (target) target.scrollIntoView({ block: 'start' });
  });
  await browser.pause(100);
}

async function screenshot(name) {
  const filePath = path.join(OUT_DIR, `${name}.png`);
  await browser.saveScreenshot(filePath);
  console.log(`  saved: ${filePath}`);
}

describe('visual: telegram message-format preview (issue #27)', () => {
  before(async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    await browser.url(POPUP_URL);
    await browser.pause(400);
    await navigateToSettings();
    await expandTelegram();
  });

  it('captures the preview with all fields (incl. description)', async () => {
    await setFormat(true);
    await scrollPreviewIntoView();
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await browser.pause(100);
      await screenshot(`telegram-preview-full-${theme}`);
    }
  });

  it('captures the preview minimal (reward only, no button)', async () => {
    await setMinimal();
    await scrollPreviewIntoView();
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await browser.pause(100);
      await screenshot(`telegram-preview-minimal-${theme}`);
    }
  });

  it('preview reacts live to message-format toggles', async () => {
    const previewText = () => browser.execute(() => document.querySelector('.tg-preview .tg-bubble')?.textContent || '');

    // Minimal (reward only) — hourly rate and the Open study button are absent.
    await setMinimal();
    await browser.pause(150);
    let text = await previewText();
    expect(text).toContain('£4.50');
    expect(text).not.toContain('/hr');
    expect(text).not.toContain('Open study');

    // Turn everything on — the same bubble now shows the hourly rate and the button, no reload.
    await setFormat(true);
    await browser.pause(150);
    text = await previewText();
    expect(text).toContain('/hr');
    expect(text).toContain('Open study');
    expect(text).toContain('Survey');
  });
});
