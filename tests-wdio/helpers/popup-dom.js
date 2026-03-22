import { POPUP_URL } from './constants.js';

/**
 * Navigate to the popup and wait for it to load.
 */
export async function navigateToPopup() {
  await browser.url(POPUP_URL);
  await (await $('#syncDot')).waitForDisplayed({ timeout: 10_000 });
}

/**
 * Read status indicators from the popup DOM atomically.
 */
export async function getPopupStatus() {
  return browser.execute(() => {
    const dot = document.getElementById('syncDot');
    const refresh = document.getElementById('latestRefresh');
    const error = document.getElementById('errorMessage');
    return {
      dot_bad: dot ? dot.classList.contains('bad') : false,
      refresh_text: refresh ? refresh.textContent : '',
      error_message: error ? error.textContent : '',
      error_visible: error
        ? error.offsetParent !== null && error.textContent.trim() !== ''
        : false,
    };
  });
}

/**
 * Switch to settings tab and expand the debug details section.
 */
async function ensureDebugDetailsOpen() {
  await (await $('button[data-tab="settings"]')).click();
  await browser.pause(300);
  const details = await $('details.debug-details');
  const isOpen = await details.getAttribute('open');
  if (isOpen === null) {
    await (await details.$('summary')).click();
    await browser.pause(300);
  }
}

/**
 * Expand diagnostics section and read debug grid key-value pairs.
 */
export async function getPopupDiagnostics() {
  await ensureDebugDetailsOpen();
  return browser.execute(() => {
    const result = {};
    for (const row of document.querySelectorAll('#debugGrid .debug-row')) {
      const key = row.querySelector('.debug-key')?.textContent ?? '';
      const value = row.querySelector('.debug-value')?.textContent ?? '';
      result[key] = value;
    }
    return result;
  });
}

/**
 * Read debug log lines from diagnostics.
 */
export async function getPopupDebugLogs() {
  await ensureDebugDetailsOpen();
  return browser.execute(() =>
    [...document.querySelectorAll('#debugLog .debug-line')]
      .map((el) => el.textContent ?? ''),
  );
}
