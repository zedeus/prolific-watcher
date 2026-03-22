import { getServerHealth, getServerStatus, getServerStudies } from '../helpers/server-api.js';

describe('Server Health', () => {
  it('should return healthy from /healthz', async () => {
    const result = await getServerHealth();
    expect(result.ok).toBe(true);
  });

  it('should return status object', async () => {
    const status = await getServerStatus();
    expect(typeof status).toBe('object');
  });

  it('should return studies with correct shape', async () => {
    const studies = await getServerStudies();
    expect(studies).toHaveProperty('results');
    expect(studies).toHaveProperty('meta');
    expect(Array.isArray(studies.results)).toBe(true);
  });
});
