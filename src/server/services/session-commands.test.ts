import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyCommandMessage,
  forgetSessionCommands,
  getSessionCommands,
  replaceSessionCommands,
  visibleCommands,
} from './session-commands';

const mockEmitCommands = vi.hoisted(() => vi.fn());
vi.mock('./events', () => ({ sseEvents: { emitCommands: mockEmitCommands } }));

const cmd = (name: string) => ({ name, description: `${name} desc`, argumentHint: '' });

const init = (terminal_slash_commands?: string[]) => ({
  type: 'system',
  subtype: 'init',
  session_id: 'sid',
  ...(terminal_slash_commands && { terminal_slash_commands }),
});

const commandsChanged = (names: string[]) => ({
  type: 'system',
  subtype: 'commands_changed',
  commands: names.map(cmd),
  uuid: 'u',
  session_id: 'sid',
});

beforeEach(() => {
  mockEmitCommands.mockClear();
  forgetSessionCommands('s');
});

describe('visibleCommands', () => {
  it('drops terminal-only commands', () => {
    expect(visibleCommands([cmd('commit'), cmd('exit')], new Set(['exit']))).toEqual([
      cmd('commit'),
    ]);
  });
});

describe('session commands', () => {
  it('replaces, emits, and forgets per session', () => {
    expect(getSessionCommands('s')).toEqual([]);
    replaceSessionCommands('s', [cmd('commit')]);
    expect(getSessionCommands('s')).toEqual([cmd('commit')]);
    expect(mockEmitCommands).toHaveBeenCalledWith('s', [cmd('commit')]);
    forgetSessionCommands('s');
    expect(getSessionCommands('s')).toEqual([]);
  });

  it('replaces the whole list on commands_changed', () => {
    replaceSessionCommands('s', [cmd('commit'), cmd('old')]);
    applyCommandMessage('s', commandsChanged(['commit', 'new-skill']));
    expect(getSessionCommands('s')).toEqual([cmd('commit'), cmd('new-skill')]);
    expect(mockEmitCommands).toHaveBeenLastCalledWith('s', [cmd('commit'), cmd('new-skill')]);
  });

  it('hides terminal-only commands when init follows the list', () => {
    replaceSessionCommands('s', [cmd('commit'), cmd('exit')]);
    applyCommandMessage('s', init(['exit']));
    expect(getSessionCommands('s')).toEqual([cmd('commit')]);
    expect(mockEmitCommands).toHaveBeenLastCalledWith('s', [cmd('commit')]);
  });

  it('hides terminal-only commands when init precedes the list', () => {
    applyCommandMessage('s', init(['exit']));
    replaceSessionCommands('s', [cmd('commit'), cmd('exit')]);
    expect(getSessionCommands('s')).toEqual([cmd('commit')]);

    applyCommandMessage('s', commandsChanged(['commit', 'exit', 'statusline']));
    expect(getSessionCommands('s')).toEqual([cmd('commit'), cmd('statusline')]);

    applyCommandMessage('s', init(['exit', 'statusline']));
    expect(mockEmitCommands).toHaveBeenLastCalledWith('s', [cmd('commit')]);
  });

  it('only emits on init when the terminal-only set changes', () => {
    replaceSessionCommands('s', [cmd('commit')]);
    mockEmitCommands.mockClear();
    applyCommandMessage('s', init());
    applyCommandMessage('s', init([]));
    applyCommandMessage('s', { type: 'assistant' });
    expect(mockEmitCommands).not.toHaveBeenCalled();
  });
});
