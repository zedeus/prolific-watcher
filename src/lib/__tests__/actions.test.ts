import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPriorityActions } from '../../entrypoints/background/actions';
import { createDefaultPriorityFilter } from '../priority-filter';
import type { Study, PriorityFilter } from '../types';

const { notificationsCreate, runtimeGetURL } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notificationsCreate: vi.fn(async () => 'notification-id') as any,
  runtimeGetURL: vi.fn((path: string) => `moz-extension://fake/${path}`),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    notifications: { create: notificationsCreate },
    runtime: { getURL: (path: string) => runtimeGetURL(path) },
    tabs: { create: vi.fn(async () => ({ id: 1 })) },
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

function createTestActions() {
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
