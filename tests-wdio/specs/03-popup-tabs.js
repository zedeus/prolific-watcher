import { navigateToPopup } from '../helpers/popup-dom.js';

describe('Popup Tabs', () => {
  beforeEach(async () => {
    await navigateToPopup();
  });

  it('should switch to settings tab', async () => {
    await (await $('button[data-tab="settings"]')).click();
    await browser.pause(300);
    const isActive = await browser.execute(() =>
      document.getElementById('panelSettings').classList.contains('active'),
    );
    expect(isActive).toBe(true);
  });

  it('should switch to feed tab', async () => {
    await (await $('button[data-tab="feed"]')).click();
    await browser.pause(300);
    const isActive = await browser.execute(() =>
      document.getElementById('panelFeed').classList.contains('active'),
    );
    expect(isActive).toBe(true);
  });

  it('should switch to submissions tab', async () => {
    await (await $('button[data-tab="submissions"]')).click();
    await browser.pause(300);
    const isActive = await browser.execute(() =>
      document.getElementById('panelSubmissions').classList.contains('active'),
    );
    expect(isActive).toBe(true);
  });

  it('should switch back to live tab', async () => {
    await (await $('button[data-tab="live"]')).click();
    await browser.pause(300);
    const isActive = await browser.execute(() =>
      document.getElementById('panelLive').classList.contains('active'),
    );
    expect(isActive).toBe(true);
  });
});
