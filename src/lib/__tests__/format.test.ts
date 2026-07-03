import { describe, it, expect } from 'vitest';
import { compareNumberDesc, deriveSyncStatusMessage } from '../format';
import {
  REFRESH_RECONNECTING_MESSAGE,
  REFRESH_PERSISTENT_FAILURE_MESSAGE,
  AUTH_REQUIRED_MESSAGE,
} from '../constants';

describe('compareNumberDesc', () => {
  it('orders larger finite numbers first', () => {
    expect([3, 1, 2].sort(compareNumberDesc)).toEqual([3, 2, 1]);
  });

  it('pushes non-finite values (NaN/Infinity) to the end', () => {
    const sorted = [NaN, 5, Infinity, 2].sort(compareNumberDesc);
    expect(sorted.slice(0, 2)).toEqual([5, 2]);
    expect(Number.isFinite(sorted[2])).toBe(false);
    expect(Number.isFinite(sorted[3])).toBe(false);
  });

  it('treats equal or both-non-finite as 0 (stable)', () => {
    expect(compareNumberDesc(2, 2)).toBe(0);
    expect(compareNumberDesc(NaN, Infinity)).toBe(0);
    expect(compareNumberDesc(NaN, NaN)).toBe(0);
  });
});

describe('deriveSyncStatusMessage (issue #25 recovery surfacing)', () => {
  it('returns empty for a healthy / null / undefined state', () => {
    expect(deriveSyncStatusMessage(null)).toBe('');
    expect(deriveSyncStatusMessage({})).toBe('');
    expect(deriveSyncStatusMessage({ token_ok: true, studies_refresh_ok: true })).toBe('');
  });

  it('shows the token reason first — auth is the root cause of most stalls', () => {
    expect(deriveSyncStatusMessage({ token_ok: false, token_reason: AUTH_REQUIRED_MESSAGE })).toBe(AUTH_REQUIRED_MESSAGE);
    // token problem outranks a refresh problem when both are present
    expect(
      deriveSyncStatusMessage({
        token_ok: false,
        token_reason: AUTH_REQUIRED_MESSAGE,
        studies_refresh_ok: false,
        studies_refresh_reason: REFRESH_PERSISTENT_FAILURE_MESSAGE,
      }),
    ).toBe(AUTH_REQUIRED_MESSAGE);
  });

  it('falls back to a generic token line when token failed without a reason', () => {
    expect(deriveSyncStatusMessage({ token_ok: false })).toBe('Token sync error.');
  });

  it('surfaces the reconnecting recovery line from a failed refresh', () => {
    expect(
      deriveSyncStatusMessage({ token_ok: true, studies_refresh_ok: false, studies_refresh_reason: REFRESH_RECONNECTING_MESSAGE }),
    ).toBe(REFRESH_RECONNECTING_MESSAGE);
  });

  it('surfaces the persistent "not updating" recovery line', () => {
    expect(
      deriveSyncStatusMessage({ token_ok: true, studies_refresh_ok: false, studies_refresh_reason: REFRESH_PERSISTENT_FAILURE_MESSAGE }),
    ).toBe(REFRESH_PERSISTENT_FAILURE_MESSAGE);
  });

  it('falls back to a generic refresh line when refresh failed without a reason', () => {
    expect(deriveSyncStatusMessage({ token_ok: true, studies_refresh_ok: false })).toBe('Studies refresh sync error.');
  });

  it('surfaces a capture problem only when supported, failed, and has a reason', () => {
    expect(
      deriveSyncStatusMessage({
        token_ok: true,
        studies_refresh_ok: true,
        studies_response_capture_supported: true,
        studies_response_capture_ok: false,
        studies_response_capture_reason: 'response stream filter error',
      }),
    ).toBe('response stream filter error');
    // Not surfaced when capture is unsupported (Chrome) even if ok===false
    expect(
      deriveSyncStatusMessage({
        token_ok: true,
        studies_refresh_ok: true,
        studies_response_capture_supported: false,
        studies_response_capture_ok: false,
        studies_response_capture_reason: 'irrelevant on chrome',
      }),
    ).toBe('');
  });

  it('trims whitespace around reasons', () => {
    expect(deriveSyncStatusMessage({ token_ok: false, token_reason: '  spaced  ' })).toBe('spaced');
  });
});
