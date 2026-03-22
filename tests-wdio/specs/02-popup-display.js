import { navigateToPopup, getPopupStatus, getPopupDiagnostics, getPopupDebugLogs } from '../helpers/popup-dom.js';

describe('Popup Display', () => {
  beforeEach(async () => {
    await navigateToPopup();
  });

  it('should load popup page', async () => {
    const title = await browser.getTitle();
    expect(title).not.toBe('');
    await expect($('#syncDot')).toBeDisplayed();
  });

  it('should show healthy status dot', async () => {
    await expect($('#syncDot')).toBeDisplayed();
    const status = await getPopupStatus();
    expect(status.dot_bad).toBe(false);
  });

  it('should show refresh time', async () => {
    const text = await (await $('#latestRefresh')).getText();
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it('should show diagnostics state', async () => {
    const diag = await getPopupDiagnostics();
    expect(typeof diag).toBe('object');
    expect(Object.keys(diag).length).toBeGreaterThan(0);
  });

  it('should show debug logs', async () => {
    const logs = await getPopupDebugLogs();
    expect(Array.isArray(logs)).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
  });
});
