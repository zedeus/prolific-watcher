import { describe, it, expect } from 'vitest';
import { createDefaultPriorityFilter, isInQuietHours } from '../priority-filter';
import type { PriorityFilter } from '../types';

function makeFilter(overrides: Partial<PriorityFilter> = {}): PriorityFilter {
  return createDefaultPriorityFilter(overrides);
}

describe('createDefaultPriorityFilter', () => {
  it('returns a filter with all required fields', () => {
    const f = createDefaultPriorityFilter();
    expect(f.id).toBeTruthy();
    expect(f.quiet_hours_enabled).toBe(false);
    expect(f.quiet_hours_start).toBe('23:00');
    expect(f.quiet_hours_end).toBe('07:00');
    expect(f.desktop_notify).toBe(false);
  });

  it('applies overrides', () => {
    const f = createDefaultPriorityFilter({ desktop_notify: true, quiet_hours_enabled: true });
    expect(f.desktop_notify).toBe(true);
    expect(f.quiet_hours_enabled).toBe(true);
  });
});

describe('isInQuietHours', () => {
  it('returns false when quiet hours are disabled', () => {
    const f = makeFilter({ quiet_hours_enabled: false, quiet_hours_start: '00:00', quiet_hours_end: '23:59' });
    expect(isInQuietHours(f, new Date('2026-07-04T12:00:00'))).toBe(false);
  });

  it('returns true during same-day quiet hours', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '09:00', quiet_hours_end: '17:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T12:00:00'))).toBe(true);
  });

  it('returns false outside same-day quiet hours', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '09:00', quiet_hours_end: '17:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T08:00:00'))).toBe(false);
    expect(isInQuietHours(f, new Date('2026-07-04T17:00:00'))).toBe(false);
    expect(isInQuietHours(f, new Date('2026-07-04T20:00:00'))).toBe(false);
  });

  it('handles overnight quiet hours (e.g. 23:00–07:00)', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '23:00', quiet_hours_end: '07:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T23:30:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T00:00:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T03:00:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T06:59:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T07:00:00'))).toBe(false);
    expect(isInQuietHours(f, new Date('2026-07-04T12:00:00'))).toBe(false);
    expect(isInQuietHours(f, new Date('2026-07-04T22:59:00'))).toBe(false);
  });

  it('returns false when start equals end', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '12:00', quiet_hours_end: '12:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T12:00:00'))).toBe(false);
  });

  it('returns false for malformed time strings', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: 'abc', quiet_hours_end: '07:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T03:00:00'))).toBe(false);

    const f2 = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '23:00', quiet_hours_end: 'xyz' });
    expect(isInQuietHours(f2, new Date('2026-07-04T23:30:00'))).toBe(false);
  });

  it('returns false for out-of-range hours', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '25:00', quiet_hours_end: '07:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T03:00:00'))).toBe(false);
  });

  it('boundary: start time is inclusive', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '22:00', quiet_hours_end: '06:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T22:00:00'))).toBe(true);
  });

  it('boundary: end time is exclusive', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '22:00', quiet_hours_end: '06:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T06:00:00'))).toBe(false);
  });

  it('works with single-digit hours', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '1:00', quiet_hours_end: '5:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T03:00:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T06:00:00'))).toBe(false);
  });

  it('handles midnight start (00:00–06:00)', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '00:00', quiet_hours_end: '06:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T00:00:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T03:00:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T05:59:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T06:00:00'))).toBe(false);
    expect(isInQuietHours(f, new Date('2026-07-04T23:00:00'))).toBe(false);
  });

  it('handles near-full-day range (00:01–23:59)', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '00:01', quiet_hours_end: '23:59' });
    expect(isInQuietHours(f, new Date('2026-07-04T12:00:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T00:00:00'))).toBe(false);
    expect(isInQuietHours(f, new Date('2026-07-04T23:59:00'))).toBe(false);
  });

  it('handles empty string times gracefully', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '', quiet_hours_end: '' });
    expect(isInQuietHours(f, new Date('2026-07-04T12:00:00'))).toBe(false);
  });

  it('handles out-of-range minutes', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '23:60', quiet_hours_end: '07:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T23:30:00'))).toBe(false);
  });

  it('handles negative hours', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '-1:00', quiet_hours_end: '07:00' });
    expect(isInQuietHours(f, new Date('2026-07-04T03:00:00'))).toBe(false);
  });

  it('narrow 1-minute quiet window', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '14:30', quiet_hours_end: '14:31' });
    expect(isInQuietHours(f, new Date('2026-07-04T14:30:00'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T14:30:59'))).toBe(true);
    expect(isInQuietHours(f, new Date('2026-07-04T14:31:00'))).toBe(false);
    expect(isInQuietHours(f, new Date('2026-07-04T14:29:00'))).toBe(false);
  });

  it('uses current time when no date provided', () => {
    const f = makeFilter({ quiet_hours_enabled: true, quiet_hours_start: '00:00', quiet_hours_end: '23:59' });
    const result = isInQuietHours(f);
    expect(typeof result).toBe('boolean');
  });
});
