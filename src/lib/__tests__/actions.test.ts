import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPriorityActions } from '../../entrypoints/background/actions';
import { createDefaultPriorityFilter } from '../priority-filter';
import type { Study, PriorityFilter } from '../types';

const { notificationsCreate, runtimeGetURL, tabsCreate } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notificationsCreate: vi.fn(async () => 'notification-id') as any,
  runtimeGetURL: vi.fn((path: string) => `moz-extension://fake/${path}`),
  tabsCreate: vi.fn(async (_opts: { url: string; active: boolean }) => ({ id: 1 })),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    notifications: { create: notificationsCreate },
    runtime: { getURL: (path: string) => runtimeGetURL(path) },
    tabs: { create: tabsCreate },
  },
}));

vi.mock('../../entrypoints/background/domain', () => ({
  extractStudyID: (s: Study) => s.id,
  parseStudyIDFromProlificURL: () => null,
  studyURLFromID: (id: string) => `https://app.prolific.com/studies/${id}`,
}));

function makeStudy(overrides: Partial<Study> = {}): Study {
  return {
    id: 'study-1',
    name: 'Test Study',
    study_type: 'SINGLE',
    date_created: '2026-01-01T00:00:00Z',
    published_at: '2026-01-01T00:00:00Z',
    total_available_places: 10,
    places_taken: 0,
    places_available: 10,
    reward: { amount: 500, currency: 'GBP' },
    average_reward_per_hour: { amount: 1000, currency: 'GBP' },
    max_submissions_per_participant: 1,
    researcher: { id: 'r-1', name: 'Dr. Test', country: 'GB' },
    description: 'Test study',
    estimated_completion_time: 10,
    device_compatibility: ['desktop'],
    peripheral_requirements: [],
    maximum_allowed_time: 60,
    average_completion_time_in_seconds: 600,
    is_confidential: false,
    is_ongoing_study: false,
    pii_enabled: false,
    is_custom_screening: false,
    study_labels: [],
    ai_inferred_study_labels: [],
    previous_submission_count: 0,
    ...overrides,
  };
}

function makeFilter(overrides: Partial<PriorityFilter> = {}): PriorityFilter {
  return createDefaultPriorityFilter(overrides);
}

function createTestActions(
  overrides: Partial<Parameters<typeof createPriorityActions>[0]> = {},
) {
  const debugLogs: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const counters: Record<string, number> = {};
  const stateUpdates: Record<string, unknown>[] = [];

  const actions = createPriorityActions({
    nowIso: () => new Date().toISOString(),
    queryProlificTabs: async () => [],
    pushDebugLog: (event, details) => debugLogs.push({ event, details }),
    bumpCounter: async (key, amount) => { counters[key] = (counters[key] || 0) + amount; },
    setState: async (partial) => { stateUpdates.push(partial); },
    limits: {
      alertCooldownMS: 7000,
      maxAutoOpenPerBatch: 3,
      maxAlertSoundVolume: 100,
      minAlertSoundVolume: 0,
      defaultAlertSoundVolume: 100,
    },
    ...overrides,
  });

  return { actions, debugLogs, counters, stateUpdates };
}

describe('handleDesktopNotifyAction', () => {
  beforeEach(() => {
    notificationsCreate.mockClear();
    runtimeGetURL.mockClear();
  });

  it('creates a browser notification when desktop_notify is enabled', async () => {
    const { actions, counters } = createTestActions();
    const filter = makeFilter({ desktop_notify: true, name: 'My Filter' });
    const studies = [makeStudy({ id: 's-1', name: 'Quick Survey' })];

    await actions.handleDesktopNotifyAction(filter, studies, 'test');

    expect(notificationsCreate).toHaveBeenCalledOnce();
    const [id, opts] = notificationsCreate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(id).toContain('pp-priority-');
    expect(id).toContain(filter.id);
    expect(opts.type).toBe('basic');
    expect(opts.title).toBe('New study available');
    expect(opts.message).toBe('Quick Survey');
    expect(opts.iconUrl).toContain('icons/icon-96.png');
    expect(counters.priority_desktop_notify_count).toBe(1);
  });

  it('pluralizes title for multiple studies', async () => {
    const { actions } = createTestActions();
    const filter = makeFilter({ desktop_notify: true });
    const studies = [
      makeStudy({ id: 's-1', name: 'Study A' }),
      makeStudy({ id: 's-2', name: 'Study B' }),
      makeStudy({ id: 's-3', name: 'Study C' }),
    ];

    await actions.handleDesktopNotifyAction(filter, studies, 'test');

    const [, opts] = notificationsCreate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts.title).toBe('3 new studies available');
    expect(opts.message).toBe('Study A\nStudy B\nStudy C');
  });

  it('truncates study names to 5 in the message body', async () => {
    const { actions } = createTestActions();
    const filter = makeFilter({ desktop_notify: true });
    const studies = Array.from({ length: 8 }, (_, i) =>
      makeStudy({ id: `s-${i}`, name: `Study ${i}` }),
    );

    await actions.handleDesktopNotifyAction(filter, studies, 'test');

    const [, opts] = notificationsCreate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const lines = (opts.message as string).split('\n');
    expect(lines).toHaveLength(5);
    expect(opts.title).toBe('8 new studies available');
  });

  it('does not fire when desktop_notify is false', async () => {
    const { actions, debugLogs } = createTestActions();
    const filter = makeFilter({ desktop_notify: false });
    const studies = [makeStudy()];

    await actions.handleDesktopNotifyAction(filter, studies, 'test');

    expect(notificationsCreate).not.toHaveBeenCalled();
    expect(debugLogs.some(l => l.event === 'priority.desktop_notify.disabled')).toBe(true);
  });

  it('does not fire for empty candidate list', async () => {
    const { actions } = createTestActions();
    const filter = makeFilter({ desktop_notify: true });

    await actions.handleDesktopNotifyAction(filter, [], 'test');

    expect(notificationsCreate).not.toHaveBeenCalled();
  });

  it('handles notifications API error gracefully', async () => {
    notificationsCreate.mockRejectedValueOnce(new Error('Permission denied'));
    const { actions, debugLogs, counters } = createTestActions();
    const filter = makeFilter({ desktop_notify: true });
    const studies = [makeStudy()];

    await actions.handleDesktopNotifyAction(filter, studies, 'test');

    expect(debugLogs.some(l => l.event === 'priority.desktop_notify.error')).toBe(true);
    expect(counters.priority_desktop_notify_count).toBeUndefined();
  });

  it('falls back to study ID when name is empty', async () => {
    const { actions } = createTestActions();
    const filter = makeFilter({ desktop_notify: true });
    const studies = [makeStudy({ id: 'abc-123', name: '' })];

    await actions.handleDesktopNotifyAction(filter, studies, 'test');

    const [, opts] = notificationsCreate.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(opts.message).toBe('abc-123');
  });

  it('uses unique notification IDs per filter', async () => {
    const { actions } = createTestActions();
    const filter1 = makeFilter({ id: 'filter-A', desktop_notify: true });
    const filter2 = makeFilter({ id: 'filter-B', desktop_notify: true });
    const studies = [makeStudy()];

    await actions.handleDesktopNotifyAction(filter1, studies, 'test');
    await actions.handleDesktopNotifyAction(filter2, studies, 'test');

    const ids = notificationsCreate.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(ids[0]).toContain('filter-A');
    expect(ids[1]).toContain('filter-B');
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('handleAutoOpenAction — focus mode (issue #21)', () => {
  beforeEach(() => {
    tabsCreate.mockClear();
  });

  it('focuses the first tab normally when no focus-mode resolver is provided', async () => {
    const { actions } = createTestActions();
    const filter = makeFilter({ auto_open_in_new_tab: true });
    const studies = [makeStudy({ id: 's-1' }), makeStudy({ id: 's-2' })];

    await actions.handleAutoOpenAction(filter, studies, 'test');

    expect(tabsCreate).toHaveBeenCalledTimes(2);
    expect((tabsCreate.mock.calls[0][0] as { active: boolean }).active).toBe(true);
    expect((tabsCreate.mock.calls[1][0] as { active: boolean }).active).toBe(false);
  });

  it('focuses normally when the resolver reports "focus"', async () => {
    const { actions } = createTestActions({ resolveAutoOpenFocusMode: async () => 'focus' });
    const filter = makeFilter({ auto_open_in_new_tab: true });

    await actions.handleAutoOpenAction(filter, [makeStudy({ id: 's-1' })], 'test');

    expect(tabsCreate).toHaveBeenCalledOnce();
    expect((tabsCreate.mock.calls[0][0] as { active: boolean }).active).toBe(true);
  });

  it('opens every tab in the background when a submission is in progress', async () => {
    const { actions, counters } = createTestActions({ resolveAutoOpenFocusMode: async () => 'background' });
    const filter = makeFilter({ auto_open_in_new_tab: true });
    const studies = [makeStudy({ id: 's-1' }), makeStudy({ id: 's-2' })];

    await actions.handleAutoOpenAction(filter, studies, 'test');

    expect(tabsCreate).toHaveBeenCalledTimes(2);
    expect((tabsCreate.mock.calls[0][0] as { active: boolean }).active).toBe(false);
    expect((tabsCreate.mock.calls[1][0] as { active: boolean }).active).toBe(false);
    // Still records the opens.
    expect(counters.priority_study_auto_open_count).toBe(2);
  });

  it('skips opening entirely when focus mode is "skip" and reports suppression', async () => {
    const { actions, debugLogs, counters } = createTestActions({ resolveAutoOpenFocusMode: async () => 'skip' });
    const filter = makeFilter({ auto_open_in_new_tab: true });

    // Returns true so the caller does NOT mark these studies auto-open-seen —
    // the opportunity must survive until the submission finishes.
    const suppressed = await actions.handleAutoOpenAction(filter, [makeStudy({ id: 's-1' })], 'test');

    expect(suppressed).toBe(true);
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(counters.priority_study_auto_open_count).toBeUndefined();
    expect(debugLogs.some((l) => l.event === 'tab.priority_auto_open.skipped_submission_in_progress')).toBe(true);
  });

  it('returns false (not suppressed) when it opens in the background', async () => {
    const { actions } = createTestActions({ resolveAutoOpenFocusMode: async () => 'background' });
    const filter = makeFilter({ auto_open_in_new_tab: true });

    const suppressed = await actions.handleAutoOpenAction(filter, [makeStudy({ id: 's-1' })], 'test');

    expect(suppressed).toBe(false);
    expect(tabsCreate).toHaveBeenCalledOnce();
  });

  it('does not consult the resolver when auto-open is disabled for the filter', async () => {
    const resolver = vi.fn(async () => 'skip' as const);
    const { actions } = createTestActions({ resolveAutoOpenFocusMode: resolver });
    const filter = makeFilter({ auto_open_in_new_tab: false });

    await actions.handleAutoOpenAction(filter, [makeStudy({ id: 's-1' })], 'test');

    expect(resolver).not.toHaveBeenCalled();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('degrades to normal focus when the resolver throws', async () => {
    const { actions, debugLogs } = createTestActions({
      resolveAutoOpenFocusMode: async () => { throw new Error('db boom'); },
    });
    const filter = makeFilter({ auto_open_in_new_tab: true });

    await actions.handleAutoOpenAction(filter, [makeStudy({ id: 's-1' })], 'test');

    // Still opens + focuses despite the resolver failing.
    expect(tabsCreate).toHaveBeenCalledOnce();
    expect((tabsCreate.mock.calls[0][0] as { active: boolean }).active).toBe(true);
    expect(debugLogs.some((l) => l.event === 'tab.priority_auto_open.focus_mode_error')).toBe(true);
  });
});
