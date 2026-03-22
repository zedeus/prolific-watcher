import { getDebugExtensionState } from '../helpers/server-api.js';
import { PROLIFIC_STUDIES_URL } from '../helpers/constants.js';

describe('Debug State Reporting', () => {
  it('should have extension state on server', async () => {
    // Ensure extension has reported state by visiting Prolific
    await browser.url(PROLIFIC_STUDIES_URL);
    await browser.pause(3000);

    const deadline = Date.now() + 15_000;
    let state = {};
    while (Date.now() < deadline) {
      state = await getDebugExtensionState();
      if (Object.keys(state).length > 0) break;
      await browser.pause(2000);
    }

    expect(Object.keys(state).length).toBeGreaterThan(0);
  });

  it('should report extension URL starting with moz-extension://', async () => {
    const state = await getDebugExtensionState();
    expect(state.extension_url).toMatch(/^moz-extension:\/\//);
  });

  it('should include sync_state object', async () => {
    const state = await getDebugExtensionState();
    expect(state).toHaveProperty('sync_state');
    expect(typeof state.sync_state).toBe('object');
  });

  it('should include received_at in raw response', async () => {
    const raw = await getDebugExtensionState(true);
    expect(raw.has_state).toBe(true);
    expect(raw).toHaveProperty('received_at');
  });
});
