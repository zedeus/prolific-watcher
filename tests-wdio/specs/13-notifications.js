/**
 * Test the browser notifications API on both Firefox and Chrome.
 *
 * Runs from the popup page (extension context with full API access).
 * Verifies notifications.create/getAll/clear work, and that the
 * desktop_notify toggle persists across popup reopens.
 */

import { navigateToPopup } from '../helpers/popup-dom.js';

function switchToSettings() {
  return browser.execute(() => {
    document.querySelector('button[data-tab="settings"]')?.click();
  });
}

async function clickToggle(id) {
  return browser.execute((id) => {
    const el = document.getElementById(id);
    if (el) el.click();
  }, id);
}

async function getToggleState(id) {
  return browser.execute((id) => {
    const el = document.getElementById(id);
    return el ? el.checked : null;
  }, id);
}

async function ensureFilterExpanded() {
  const hasFilter = await browser.execute(() =>
    document.querySelectorAll('[data-filter-id]').length > 0,
  );
  if (!hasFilter) {
    await browser.execute(() =>
      document.getElementById('addFilterButton')?.click(),
    );
    await browser.pause(500);
  }
  const isExpanded = await browser.execute(() =>
    !!document.getElementById('priorityMinRewardInput-0'),
  );
  if (!isExpanded) {
    await browser.execute(() => {
      const card = document.querySelector('[data-filter-id]');
      if (card) {
        const btn = card.querySelector('button[aria-label="Expand filter"]');
        if (btn) btn.click();
      }
    });
    await browser.pause(300);
  }
}

async function reopenPopup() {
  await browser.url('about:blank');
  await browser.pause(500);
  await navigateToPopup();
  await browser.pause(1000);
  await switchToSettings();
  await browser.pause(300);
}

describe('Desktop Notifications API', () => {
  it('notifications.create succeeds with the extension permission', async () => {
    await navigateToPopup();

    const result = await browser.executeAsync(async (done) => {
      const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
      try {
        const id = await api.notifications.create('pp-test-1', {
          type: 'basic',
          iconUrl: api.runtime.getURL('icons/icon-96.png'),
          title: 'Prolific Pulse Test',
          message: 'Notifications API works',
        });
        done({ ok: true, id });
      } catch (err) {
        done({ ok: false, error: err.message });
      }
    });

    expect(result.ok).toBe(true);
    expect(result.id).toBeTruthy();
  });

  it('notifications.getAll returns the created notification', async () => {
    const all = await browser.executeAsync(async (done) => {
      const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
      try {
        const notifications = await api.notifications.getAll();
        done({ ok: true, ids: Object.keys(notifications), count: Object.keys(notifications).length });
      } catch (err) {
        done({ ok: false, error: err.message });
      }
    });

    expect(all.ok).toBe(true);
    expect(all.count).toBeGreaterThanOrEqual(1);
    expect(all.ids).toContain('pp-test-1');
  });

  it('notifications.clear removes the test notification', async () => {
    const result = await browser.executeAsync(async (done) => {
      const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
      try {
        await api.notifications.clear('pp-test-1');
        const remaining = await api.notifications.getAll();
        done({ ok: true, remaining: Object.keys(remaining) });
      } catch (err) {
        done({ ok: false, error: err.message });
      }
    });

    expect(result.ok).toBe(true);
    expect(result.remaining).not.toContain('pp-test-1');
  });

  it('desktop_notify toggle persists across popup reopen', async () => {
    await navigateToPopup();
    await switchToSettings();
    await browser.pause(300);
    await ensureFilterExpanded();

    // Enable desktop notify via UI click
    if (!(await getToggleState('priorityDesktopNotifyToggle-0'))) {
      await clickToggle('priorityDesktopNotifyToggle-0');
      await browser.pause(1500);
    }
    expect(await getToggleState('priorityDesktopNotifyToggle-0')).toBe(true);

    // Reopen popup — should reflect the persisted change
    await reopenPopup();
    await ensureFilterExpanded();

    const persisted = await getToggleState('priorityDesktopNotifyToggle-0');
    expect(persisted).toBe(true);

    // Disable it back
    await clickToggle('priorityDesktopNotifyToggle-0');
    await browser.pause(500);
  });

  it('synthetic study triggers desktop notification via priority pipeline', async () => {
    await navigateToPopup();
    await switchToSettings();
    await browser.pause(300);
    await ensureFilterExpanded();

    // Enable filter + desktop notify
    if (!(await getToggleState('priorityFilterEnabledToggle-0'))) {
      await clickToggle('priorityFilterEnabledToggle-0');
      await browser.pause(1000);
    }
    if (!(await getToggleState('priorityDesktopNotifyToggle-0'))) {
      await clickToggle('priorityDesktopNotifyToggle-0');
      await browser.pause(1000);
    }

    // Set min reward to 0 so the synthetic study matches
    await browser.execute(() => {
      const el = document.getElementById('priorityMinRewardInput-0');
      if (el) {
        el.value = '0';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await browser.pause(2000);

    // Clear existing notifications
    await browser.executeAsync(async (done) => {
      const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
      const all = await api.notifications.getAll();
      for (const id of Object.keys(all)) await api.notifications.clear(id);
      done();
    });

    // Inject a synthetic study to trigger the priority pipeline.
    // The first injection establishes the baseline, so we inject twice.
    for (let i = 0; i < 2; i++) {
      await browser.executeAsync(async (i, done) => {
        const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
        const study = {
          id: `TEST-NOTIFY-${i}-${Date.now()}`,
          name: `E2E Notification Test ${i}`,
          study_type: 'SINGLE',
          date_created: new Date().toISOString(),
          published_at: new Date().toISOString(),
          total_available_places: 10,
          places_taken: 0,
          reward: { amount: 500, currency: 'GBP' },
          average_reward_per_hour: { amount: 1000, currency: 'GBP' },
          maximum_allowed_time: 60,
          estimated_completion_time: 10,
          researcher: { id: `test-r-${i}`, name: 'Test Researcher' },
          description: 'Test study',
        };

        api.runtime.sendMessage({
          action: 'interceptedResponse',
          subtype: 'studies',
          url: 'https://internal-api.prolific.com/api/v1/participant/studies/?current=1',
          status: 200,
          body: { results: [study], meta: { count: 1 } },
          observed_at: new Date().toISOString(),
        });
        done();
      }, i);
      await browser.pause(3000);
    }

    // Check for priority notifications
    const notifications = await browser.executeAsync(async (done) => {
      const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
      const all = await api.notifications.getAll();
      done({ ids: Object.keys(all), count: Object.keys(all).length });
    });

    expect(notifications.count).toBeGreaterThanOrEqual(1);
    expect(notifications.ids.some((id) => id.startsWith('pp-priority-'))).toBe(true);

    // Clean up
    await browser.executeAsync(async (done) => {
      const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
      const all = await api.notifications.getAll();
      for (const id of Object.keys(all)) await api.notifications.clear(id);
      done();
    });

    // Disable desktop_notify
    await navigateToPopup();
    await switchToSettings();
    await browser.pause(300);
    await ensureFilterExpanded();
    if (await getToggleState('priorityDesktopNotifyToggle-0')) {
      await clickToggle('priorityDesktopNotifyToggle-0');
      await browser.pause(500);
    }
  });
});
