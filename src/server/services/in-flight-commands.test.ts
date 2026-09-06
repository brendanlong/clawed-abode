import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  effectiveRunning,
  handleCommandLifecycle,
  pendingMessageIds,
  retireInFlightCommands,
  syncRunning,
} from './in-flight-commands';
import { createSessionState } from './session-state';

const mockSse = vi.hoisted(() => ({ emitClaudeRunning: vi.fn(), emitPendingMessages: vi.fn() }));
vi.mock('./events', () => ({ sseEvents: mockSse }));
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('./uploads', () => ({ resolveUploadPaths: vi.fn() }));

const lifecycle = (command_uuid: string, state: string) =>
  ({ type: 'command_lifecycle', command_uuid, state }) as unknown as SDKMessage;
const messageStart = (parent: string | null = null) =>
  ({
    type: 'stream_event',
    parent_tool_use_id: parent,
    event: { type: 'message_start' },
  }) as unknown as SDKMessage;
const result = () => ({ type: 'result' }) as unknown as SDKMessage;

function stateWith(commands: Record<string, { started?: boolean }>) {
  const state = createSessionState('/w', []);
  for (const [uuid, c] of Object.entries(commands)) {
    state.inFlightCommands.set(uuid, {
      messageId: `m-${uuid}`,
      text: uuid,
      attachments: [],
      started: c.started ?? false,
      resultsSeen: 0,
    });
  }
  return state;
}

beforeEach(() => vi.clearAllMocks());

describe('running derivation', () => {
  it('is on for a live turn or an undelivered push, and emits only on change', () => {
    const state = stateWith({ a: {} });
    expect(effectiveRunning(state)).toBe(true);
    expect(syncRunning('s', state)).toBe(true);
    expect(syncRunning('s', state)).toBe(false);
    state.inFlightCommands.clear();
    expect(effectiveRunning(state)).toBe(false);
    expect(syncRunning('s', state)).toBe(true);
    expect(mockSse.emitClaudeRunning.mock.calls).toEqual([
      ['s', true],
      ['s', false],
    ]);
  });
});

describe('handleCommandLifecycle', () => {
  it('ignores non-lifecycle messages and records that the CLI reports lifecycles', () => {
    const state = stateWith({ a: {} });
    expect(handleCommandLifecycle('s', state, { type: 'assistant' })).toBe(false);
    expect(state.commandLifecycleSeen).toBe(false);
    expect(handleCommandLifecycle('s', state, lifecycle('a', 'queued'))).toBe(true);
    expect(state.commandLifecycleSeen).toBe(true);
    expect(pendingMessageIds(state)).toEqual(['m-a']);
  });

  it('"started" clears the pending marker but keeps the entry; a terminal state retires it', () => {
    const state = stateWith({ a: {}, b: {} });
    handleCommandLifecycle('s', state, lifecycle('a', 'started'));
    expect(pendingMessageIds(state)).toEqual(['m-b']);
    expect(state.inFlightCommands.has('a')).toBe(true);
    handleCommandLifecycle('s', state, lifecycle('b', 'completed'));
    expect(state.inFlightCommands.has('b')).toBe(false);
    expect(mockSse.emitPendingMessages).toHaveBeenLastCalledWith('s', []);
  });
});

describe('retireInFlightCommands', () => {
  it('a top-level message_start retires entries the agent has read, not unread ones', () => {
    const state = stateWith({ read: { started: true }, unread: {} });
    state.commandLifecycleSeen = true;
    retireInFlightCommands('s', state, messageStart('subagent-tool-use'));
    expect(state.inFlightCommands.size).toBe(2);
    retireInFlightCommands('s', state, messageStart());
    expect([...state.inFlightCommands.keys()]).toEqual(['unread']);
  });

  it('with lifecycle reports, an entry may survive one result boundary and no more', () => {
    const state = stateWith({ a: {} });
    state.commandLifecycleSeen = true;
    retireInFlightCommands('s', state, result());
    expect(state.inFlightCommands.size).toBe(1);
    retireInFlightCommands('s', state, result());
    expect(state.inFlightCommands.size).toBe(0);
  });

  it('without any lifecycle reports, the first boundary retires everything', () => {
    const state = stateWith({ a: {}, b: {} });
    retireInFlightCommands('s', state, result());
    expect(state.inFlightCommands.size).toBe(0);
    const state2 = stateWith({ a: {} });
    retireInFlightCommands('s', state2, messageStart());
    expect(state2.inFlightCommands.size).toBe(0);
  });
});
