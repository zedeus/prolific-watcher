import { describe, it, expect } from 'vitest';
import {
  pauseUntilFromDuration,
  normalizePauseState,
  pauseRemainingLabel,
} from '../pause';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

describe('pauseUntilFromDuration', () => {
  it('returns null for forever', () => {
    expect(pauseUntilFromDuration('forever', NOW)).toBeNull();
  });
  it('adds an hour for 1h', () => {
    expect(pauseUntilFromDuration('1h', NOW)).toBe(NOW + HOUR);
  });
  it('adds 8 hours for 8h', () => {
    expect(pauseUntilFromDuration('8h', NOW)).toBe(NOW + 8 * HOUR);
  });
});

describe('normalizePauseState', () => {
  it('returns null for non-objects / absent state', () => {
    expect(normalizePauseState(null, NOW)).toBeNull();
    expect(normalizePauseState(undefined, NOW)).toBeNull();
    expect(normalizePauseState(false, NOW)).toBeNull();
    expect(normalizePauseState('paused', NOW)).toBeNull();
  });

  it('reads an indefinite pause', () => {
    expect(normalizePauseState({ until: null }, NOW)).toEqual({ until: null });
  });

  it('reads a live timed pause', () => {
    expect(normalizePauseState({ until: NOW + HOUR }, NOW)).toEqual({ until: NOW + HOUR });
  });

  it('treats a lapsed timed pause as not paused', () => {
    expect(normalizePauseState({ until: NOW - 1 }, NOW)).toBeNull();
  });

  it('treats the exact deadline as lapsed', () => {
    expect(normalizePauseState({ until: NOW }, NOW)).toBeNull();
  });

  it('rejects a garbage until', () => {
    expect(normalizePauseState({ until: 'soon' }, NOW)).toBeNull();
    expect(normalizePauseState({ until: NaN }, NOW)).toBeNull();
  });
});

describe('pauseRemainingLabel', () => {
  it('is empty for indefinite or not-paused', () => {
    expect(pauseRemainingLabel({ until: null }, NOW)).toBe('');
    expect(pauseRemainingLabel(null, NOW)).toBe('');
  });
  it('formats bare minutes then hours (each surface adds its own phrasing)', () => {
    expect(pauseRemainingLabel({ until: NOW + 30 * 60 * 1000 }, NOW)).toBe('30m');
    expect(pauseRemainingLabel({ until: NOW + 3 * HOUR }, NOW)).toBe('3h');
  });
  it('is empty once lapsed', () => {
    expect(pauseRemainingLabel({ until: NOW - 1 }, NOW)).toBe('');
  });
  it('rounds up sub-minute remainders to 1m', () => {
    expect(pauseRemainingLabel({ until: NOW + 20_000 }, NOW)).toBe('1m');
  });
});
