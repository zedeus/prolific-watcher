import { getServerStatus, getServerStudies } from '../helpers/server-api.js';
import { PROLIFIC_STUDIES_URL } from '../helpers/constants.js';

describe('Studies Interception', () => {
  it('should receive studies data after page load', async () => {
    // Record state before navigation so we verify a NEW refresh happens
    const before = await getServerStatus();
    const beforeAt = before.last_studies_refresh_at;

    await browser.url(PROLIFIC_STUDIES_URL);
    await browser.pause(3000);

    const deadline = Date.now() + 15_000;
    let status;
    while (Date.now() < deadline) {
      status = await getServerStatus();
      if (status.last_studies_refresh_at != null &&
          status.last_studies_refresh_at !== beforeAt) break;
      await browser.pause(2000);
    }

    status = await getServerStatus();
    expect(status.last_studies_refresh_at != null).toBe(true);
    expect(status.last_studies_refresh_at).not.toBe(beforeAt);
  });

  it('should show extension as refresh source', async () => {
    const status = await getServerStatus();
    expect(status.last_studies_refresh_source).toContain('extension');
  });

  it('should populate studies results', async () => {
    const studies = await getServerStudies();
    expect(Array.isArray(studies.results)).toBe(true);
    expect(typeof studies.meta.count).toBe('number');
  });

  it('should fire delayed refresh @slow', async function () {
    this.timeout(150_000);
    const initialStatus = await getServerStatus();
    const initialAt = initialStatus.last_studies_refresh_at;

    await browser.url(PROLIFIC_STUDIES_URL);
    await browser.pause(5000);

    // Wait for the first refresh from this navigation
    let firstAt = initialAt;
    const firstDeadline = Date.now() + 15_000;
    while (Date.now() < firstDeadline) {
      const s = await getServerStatus();
      if (s.last_studies_refresh_at && s.last_studies_refresh_at !== initialAt) {
        firstAt = s.last_studies_refresh_at;
        break;
      }
      await browser.pause(2000);
    }

    expect(firstAt).not.toBe(initialAt);

    // Now wait for the DELAYED refresh (a second, different timestamp).
    // Default average delay is 30s (exponential distribution), so can be 40-60s+.
    const deadline = Date.now() + 90_000;
    let newAt = null;
    while (Date.now() < deadline) {
      await browser.pause(3000);
      const status = await getServerStatus();
      const currentAt = status.last_studies_refresh_at;
      if (currentAt && currentAt !== firstAt) {
        newAt = currentAt;
        break;
      }
    }

    expect(newAt).not.toBeNull();
  });
});
