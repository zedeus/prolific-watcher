import { navigateToPopup } from '../helpers/popup-dom.js';
import { togglePriorityFilter, setPriorityFilter } from '../helpers/popup-settings.js';
import { POPUP_URL } from '../helpers/constants.js';

describe('Settings', () => {
  it('should change priority filter', async () => {
    await navigateToPopup();
    await togglePriorityFilter(true);
    await setPriorityFilter({ minReward: 5.0 });
    await browser.pause(1000);

    const value = await (await $('#priorityMinRewardInput')).getValue();
    expect(value === '5.0' || value === '5').toBe(true);
  });

  it('should persist settings across popup reopen', async () => {
    await navigateToPopup();
    await togglePriorityFilter(true);
    await setPriorityFilter({ minHourly: 7.5 });
    await browser.pause(1500);

    // Navigate away and back (simulates close/reopen)
    await browser.url('about:blank');
    await browser.pause(500);
    await browser.url(POPUP_URL);
    await (await $('#syncDot')).waitForDisplayed({ timeout: 10_000 });
    await browser.pause(1000);

    await (await $('button[data-tab="settings"]')).click();
    await browser.pause(300);

    const value = await (await $('#priorityMinHourlyInput')).getValue();
    expect(value === '7.5' || parseFloat(value) === 7.5).toBe(true);
  });
});
