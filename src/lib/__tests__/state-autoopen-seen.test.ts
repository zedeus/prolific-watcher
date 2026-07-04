import { describe, it, expect, vi } from 'vitest';
import type { Study } from '../types';

vi.mock('wxt/browser', () => ({
  browser: {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  },
}));

import { createPriorityState } from '../../entrypoints/background/state';

function makeState() {
  return createPriorityState({
    storageKey: 'test-known-studies',
    nowIso: () => new Date().toISOString(),
    limits: {
      knownStudiesTTLMS: 6 * 60 * 60 * 1000,
      maxKnownStudies: 1000,
      actionSeenTTLMS: 15 * 60 * 1000,
      maxActionSeenStudies: 1000,
      telegramSeenTTLMS: 60 * 60 * 1000,
    },
  });
}

const study = (id: string) => ({ id }) as unknown as Study;

// Regression for issue #21: `skip` mode must clear the auto-open-seen mark so a
// study stays eligible for auto-open once the submission finishes, while the
// synchronous mark-before-await still prevents a double open.
describe('clearAutoOpenSeen', () => {
  it('re-enables only the cleared studies for auto-open', () => {
    const s = makeState();
    const studies = [study('a'), study('b')];

    expect(s.selectAutoOpenCandidates(studies).map((x) => x.id)).toEqual(['a', 'b']);
    s.markAutoOpenSeen(studies);
    expect(s.selectAutoOpenCandidates(studies)).toEqual([]);

    s.clearAutoOpenSeen([study('a')]);
    expect(s.selectAutoOpenCandidates(studies).map((x) => x.id)).toEqual(['a']);
  });

  it('clears only the auto-open map, leaving alert/desktop seen intact', () => {
    const s = makeState();
    const studies = [study('a')];

    s.markAlertSeen(studies);
    s.markDesktopNotifySeen(studies);
    s.markAutoOpenSeen(studies);

    s.clearAutoOpenSeen(studies);

    expect(s.selectAutoOpenCandidates(studies).map((x) => x.id)).toEqual(['a']); // re-eligible
    expect(s.selectAlertCandidates(studies)).toEqual([]); // still seen
    expect(s.selectDesktopNotifyCandidates(studies)).toEqual([]); // still seen
  });

  it('is a no-op for studies that were never marked', () => {
    const s = makeState();
    expect(() => s.clearAutoOpenSeen([study('never')])).not.toThrow();
    expect(s.selectAutoOpenCandidates([study('never')]).map((x) => x.id)).toEqual(['never']);
  });
});
