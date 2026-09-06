import { describe, it, expect, vi } from 'vitest';
import {
  forgetSessionCommands,
  getSessionCommands,
  mergeInitCommands,
  mergeSlashCommands,
  rememberSessionCommands,
} from './session-commands';
import { createSessionState } from './session-state';

const mockEmitCommands = vi.hoisted(() => vi.fn());
vi.mock('./events', () => ({ sseEvents: { emitCommands: mockEmitCommands } }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));

const rich = { name: 'commit', description: 'Commit changes', argumentHint: '' };
const bare = (name: string) => ({ name, description: '', argumentHint: '' });

describe('mergeSlashCommands', () => {
  it('keeps rich metadata and appends unknown names once, in order', () => {
    expect(mergeSlashCommands([rich], ['commit', 'compact', 'compact', 'cost'])).toEqual([
      rich,
      bare('compact'),
      bare('cost'),
    ]);
    expect(mergeSlashCommands([], [])).toEqual([]);
  });
});

describe('persisted session commands', () => {
  it('remembers, returns and forgets per session', () => {
    expect(getSessionCommands('none')).toEqual([]);
    rememberSessionCommands('s1', [rich]);
    expect(getSessionCommands('s1')).toEqual([rich]);
    forgetSessionCommands('s1');
    expect(getSessionCommands('s1')).toEqual([]);
  });
});

describe('mergeInitCommands', () => {
  const init = (slash_commands: string[]) =>
    ({
      type: 'system',
      subtype: 'init',
      cwd: '/w',
      session_id: 'sid',
      model: 'opus',
      slash_commands,
    }) as never;

  it('folds new names from a system init message into state, persistence and SSE', () => {
    const state = createSessionState('/w', [rich]);
    mergeInitCommands('s2', state, init(['commit', 'compact']));
    expect(state.commands).toEqual([rich, bare('compact')]);
    expect(getSessionCommands('s2')).toEqual([rich, bare('compact')]);
    expect(mockEmitCommands).toHaveBeenCalledWith('s2', [rich, bare('compact')]);
    forgetSessionCommands('s2');
  });

  it('is silent when nothing is new or the message is not an init', () => {
    mockEmitCommands.mockClear();
    const state = createSessionState('/w', [rich]);
    mergeInitCommands('s3', state, init(['commit']));
    mergeInitCommands('s3', state, { type: 'assistant' } as never);
    expect(mockEmitCommands).not.toHaveBeenCalled();
    expect(getSessionCommands('s3')).toEqual([]);
  });
});
