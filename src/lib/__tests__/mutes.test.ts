import { describe, it, expect } from 'vitest';
import {
  normalizeMuteList,
  createMuteEntry,
  addMuteEntry,
  removeMuteEntry,
  isStudyMuted,
  isTargetMuted,
  muteUntilFromDuration,
  type MuteEntry,
} from '../mutes';

const NOW = 1_700_000_000_000; // fixed epoch ms
const HOUR = 60 * 60 * 1000;

function studyLike(id: string, researcherId = '') {
  return { id, researcher: { id: researcherId } };
}

describe('muteUntilFromDuration', () => {
  it('returns null for forever', () => {
    expect(muteUntilFromDuration('forever', NOW)).toBeNull();
  });
  it('adds an hour for 1h', () => {
    expect(muteUntilFromDuration('1h', NOW)).toBe(NOW + HOUR);
  });
  it('adds a day for 24h', () => {
    expect(muteUntilFromDuration('24h', NOW)).toBe(NOW + 24 * HOUR);
  });
});

describe('createMuteEntry', () => {
  it('trims id/label and stamps created_at', () => {
    const e = createMuteEntry('study', '  s-1  ', '  My Study  ', '1h', NOW);
    expect(e).toEqual({
      scope: 'study',
      id: 's-1',
      label: 'My Study',
      until: NOW + HOUR,
      created_at: NOW,
    });
  });
  it('forever entries have null until', () => {
    expect(createMuteEntry('researcher', 'r-1', 'Dr X', 'forever', NOW).until).toBeNull();
  });
});

describe('normalizeMuteList', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeMuteList(null, NOW)).toEqual([]);
    expect(normalizeMuteList(undefined, NOW)).toEqual([]);
    expect(normalizeMuteList('nope', NOW)).toEqual([]);
    expect(normalizeMuteList({}, NOW)).toEqual([]);
  });

  it('drops expired timed mutes but keeps live ones and forever mutes', () => {
    const raw: MuteEntry[] = [
      { scope: 'study', id: 'expired', label: '', until: NOW - 1, created_at: NOW - HOUR },
      { scope: 'study', id: 'live', label: '', until: NOW + HOUR, created_at: NOW },
      { scope: 'researcher', id: 'forever', label: '', until: null, created_at: NOW },
    ];
    const ids = normalizeMuteList(raw, NOW).map((m) => m.id);
    expect(ids).toContain('live');
    expect(ids).toContain('forever');
    expect(ids).not.toContain('expired');
  });

  it('drops entries with missing scope/id or garbage expiry', () => {
    const raw = [
      { scope: 'study', id: '', label: '', until: null, created_at: NOW },
      { scope: 'bogus', id: 's-1', label: '', until: null, created_at: NOW },
      { scope: 'study', id: 's-2', label: '', until: 'soon', created_at: NOW },
      { scope: 'study', id: 's-3', label: '', until: null, created_at: NOW },
    ];
    const ids = normalizeMuteList(raw, NOW).map((m) => m.id);
    expect(ids).toEqual(['s-3']);
  });

  it('dedupes same target keeping the strongest (forever > later expiry)', () => {
    const raw: MuteEntry[] = [
      { scope: 'study', id: 's-1', label: 'a', until: NOW + HOUR, created_at: NOW - 10 },
      { scope: 'study', id: 's-1', label: 'b', until: null, created_at: NOW - 5 },
      { scope: 'study', id: 's-1', label: 'c', until: NOW + 2 * HOUR, created_at: NOW },
    ];
    const out = normalizeMuteList(raw, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].until).toBeNull(); // forever won
  });

  it('sorts newest-first by created_at', () => {
    const raw: MuteEntry[] = [
      { scope: 'study', id: 'old', label: '', until: null, created_at: NOW - 100 },
      { scope: 'study', id: 'new', label: '', until: null, created_at: NOW },
    ];
    expect(normalizeMuteList(raw, NOW).map((m) => m.id)).toEqual(['new', 'old']);
  });

  it('treats a study and researcher with the same id as distinct', () => {
    const raw: MuteEntry[] = [
      { scope: 'study', id: 'x', label: '', until: null, created_at: NOW },
      { scope: 'researcher', id: 'x', label: '', until: null, created_at: NOW },
    ];
    expect(normalizeMuteList(raw, NOW)).toHaveLength(2);
  });

  it('caps a huge list at MAX_MUTE_ENTRIES, keeping the newest', () => {
    const raw: MuteEntry[] = Array.from({ length: 900 }, (_, i) => ({
      scope: 'study' as const,
      id: `s-${i}`,
      label: '',
      until: null,
      created_at: NOW - i, // lower index = newer
    }));
    const out = normalizeMuteList(raw, NOW);
    expect(out).toHaveLength(500); // MAX_MUTE_ENTRIES
    expect(out[0].id).toBe('s-0'); // newest kept
    expect(out.some((m) => m.id === 's-899')).toBe(false); // oldest dropped
  });

  it('survives a list full of junk without throwing', () => {
    const raw = [null, undefined, 42, 'str', {}, { scope: 'study' }, { id: 'x' }, [], { scope: 'study', id: 'ok', until: null, created_at: NOW }];
    const out = normalizeMuteList(raw, NOW);
    expect(out.map((m) => m.id)).toEqual(['ok']);
  });
});

describe('addMuteEntry / removeMuteEntry', () => {
  it('adds a new mute', () => {
    const entry = createMuteEntry('study', 's-1', 'S', '1h', NOW);
    const out = addMuteEntry([], entry, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('s-1');
  });

  it('replaces an existing mute for the same target (re-snooze updates expiry)', () => {
    const first = createMuteEntry('study', 's-1', 'S', '1h', NOW);
    const list1 = addMuteEntry([], first, NOW);
    const second = createMuteEntry('study', 's-1', 'S', 'forever', NOW + 10);
    const list2 = addMuteEntry(list1, second, NOW + 10);
    expect(list2).toHaveLength(1);
    expect(list2[0].until).toBeNull();
  });

  it('removes a mute for a specific target only', () => {
    const list = [
      createMuteEntry('study', 's-1', '', 'forever', NOW),
      createMuteEntry('researcher', 'r-1', '', 'forever', NOW),
    ];
    const out = removeMuteEntry(list, 'study', 's-1');
    expect(out.map((m) => `${m.scope}:${m.id}`)).toEqual(['researcher:r-1']);
  });

  it('remove trims the id', () => {
    const list = [createMuteEntry('study', 's-1', '', 'forever', NOW)];
    expect(removeMuteEntry(list, 'study', '  s-1 ')).toHaveLength(0);
  });
});

describe('isStudyMuted', () => {
  it('is false with no mutes', () => {
    expect(isStudyMuted(studyLike('s-1', 'r-1'), [], NOW)).toBe(false);
  });

  it('matches a direct study mute', () => {
    const mutes = [createMuteEntry('study', 's-1', '', 'forever', NOW)];
    expect(isStudyMuted(studyLike('s-1', 'r-1'), mutes, NOW)).toBe(true);
    expect(isStudyMuted(studyLike('s-2', 'r-1'), mutes, NOW)).toBe(false);
  });

  it('matches a researcher mute across the researcher\'s studies', () => {
    const mutes = [createMuteEntry('researcher', 'r-1', '', 'forever', NOW)];
    expect(isStudyMuted(studyLike('s-1', 'r-1'), mutes, NOW)).toBe(true);
    expect(isStudyMuted(studyLike('s-2', 'r-1'), mutes, NOW)).toBe(true);
    expect(isStudyMuted(studyLike('s-3', 'r-2'), mutes, NOW)).toBe(false);
  });

  it('ignores expired timed mutes', () => {
    const mutes: MuteEntry[] = [
      { scope: 'study', id: 's-1', label: '', until: NOW - 1, created_at: NOW - HOUR },
    ];
    expect(isStudyMuted(studyLike('s-1'), mutes, NOW)).toBe(false);
  });

  it('honours a live timed mute until it lapses', () => {
    const mutes = [createMuteEntry('study', 's-1', '', '1h', NOW)];
    expect(isStudyMuted(studyLike('s-1'), mutes, NOW + 30 * 60 * 1000)).toBe(true);
    expect(isStudyMuted(studyLike('s-1'), mutes, NOW + HOUR + 1)).toBe(false);
  });

  it('handles studies with no researcher id safely', () => {
    const mutes = [createMuteEntry('researcher', '', '', 'forever', NOW)];
    expect(isStudyMuted(studyLike('s-1', ''), mutes, NOW)).toBe(false);
  });

  it('returns false for null study', () => {
    const mutes = [createMuteEntry('study', 's-1', '', 'forever', NOW)];
    expect(isStudyMuted(null, mutes, NOW)).toBe(false);
    expect(isStudyMuted(undefined, mutes, NOW)).toBe(false);
  });
});

describe('isTargetMuted', () => {
  it('reflects an active mute for a target', () => {
    const mutes = [createMuteEntry('researcher', 'r-1', '', '24h', NOW)];
    expect(isTargetMuted('researcher', 'r-1', mutes, NOW)).toBe(true);
    expect(isTargetMuted('study', 'r-1', mutes, NOW)).toBe(false);
    expect(isTargetMuted('researcher', 'r-1', mutes, NOW + 25 * HOUR)).toBe(false);
  });

  it('is false for blank id', () => {
    expect(isTargetMuted('study', '   ', [], NOW)).toBe(false);
  });
});
