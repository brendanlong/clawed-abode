import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  classifyMessage,
  getParentToolUseId,
  parseCommandLifecycle,
  isIgnoredSystemMessage,
  parseRetryState,
  formatRetryReason,
  initSessionId,
  parseInjectedOrigin,
  isEchoOfPushedPrompt,
} from './claude-messages';

describe('claude-messages', () => {
  describe('classifyMessage', () => {
    // Synthetic messages; classifyMessage only inspects type/subtype.
    const msg = (m: Record<string, unknown>) => classifyMessage(m as unknown as SDKMessage);

    it('persists user/assistant/result under their own db type', () => {
      expect(msg({ type: 'assistant' })).toEqual({ kind: 'persist', dbType: 'assistant' });
      expect(msg({ type: 'user' })).toEqual({ kind: 'persist', dbType: 'user' });
      expect(msg({ type: 'result' })).toEqual({ kind: 'persist', dbType: 'result' });
    });

    it('persists non-system progress-ish types as system', () => {
      expect(msg({ type: 'tool_progress' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'tool_use_summary' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'auth_status' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'rate_limit_event' })).toEqual({ kind: 'persist', dbType: 'system' });
      expect(msg({ type: 'prompt_suggestion' })).toEqual({ kind: 'persist', dbType: 'system' });
    });

    it('skips conversation_reset lifecycle messages', () => {
      expect(msg({ type: 'conversation_reset' })).toEqual({ kind: 'skip' });
    });

    it('persists ordinary system messages as system', () => {
      expect(msg({ type: 'system', subtype: 'init' })).toEqual({
        kind: 'persist',
        dbType: 'system',
      });
      expect(msg({ type: 'system' })).toEqual({ kind: 'persist', dbType: 'system' });
    });

    it('skips ignored system progress/state events', () => {
      for (const subtype of [
        'thinking_tokens',
        'task_progress',
        'task_updated',
        'background_tasks_changed',
        'hook_progress',
        'status',
        'session_state_changed',
        'files_persisted',
        'elicitation_complete',
        'commands_changed',
        'api_retry',
      ]) {
        expect(msg({ type: 'system', subtype })).toEqual({ kind: 'skip' });
      }
    });

    it('skips system messages flagged skip_transcript', () => {
      expect(msg({ type: 'system', subtype: 'task_started', skip_transcript: true })).toEqual({
        kind: 'skip',
      });
    });

    it('persists summarized system subtypes', () => {
      for (const subtype of ['notification', 'permission_denied', 'task_notification']) {
        expect(msg({ type: 'system', subtype })).toEqual({ kind: 'persist', dbType: 'system' });
      }
    });

    it('marks stream events for separate accumulation', () => {
      expect(msg({ type: 'stream_event' })).toEqual({ kind: 'stream_event' });
    });

    it('degrades unknown future types to system persistence at runtime', () => {
      expect(msg({ type: 'some_future_type' })).toEqual({ kind: 'persist', dbType: 'system' });
    });

    it('skips command_lifecycle, which is delivery bookkeeping and not transcript content', () => {
      // It is missing from SDKMessage, so without an explicit skip it would fall
      // through to the unknown-type default above and render as a system bubble.
      expect(msg({ type: 'command_lifecycle', command_uuid: 'c1', state: 'started' })).toEqual({
        kind: 'skip',
      });
    });
  });

  describe('parseCommandLifecycle', () => {
    it('parses a lifecycle report', () => {
      expect(
        parseCommandLifecycle({ type: 'command_lifecycle', command_uuid: 'c1', state: 'queued' })
      ).toEqual({ type: 'command_lifecycle', command_uuid: 'c1', state: 'queued' });
    });

    it('accepts states beyond the ones we have observed', () => {
      // `state` is deliberately open: only 'queued' is load-bearing, and a new
      // terminal state must retire the pending message rather than be dropped.
      expect(
        parseCommandLifecycle({
          type: 'command_lifecycle',
          command_uuid: 'c1',
          state: 'superseded',
        })
      ).toMatchObject({ state: 'superseded' });
    });

    it('returns null for other messages and malformed payloads', () => {
      expect(parseCommandLifecycle({ type: 'assistant' })).toBeNull();
      expect(parseCommandLifecycle({ type: 'command_lifecycle', state: 'started' })).toBeNull();
      expect(
        parseCommandLifecycle({ type: 'command_lifecycle', command_uuid: '', state: 'x' })
      ).toBeNull();
      expect(parseCommandLifecycle(null)).toBeNull();
    });
  });

  describe('isIgnoredSystemMessage', () => {
    it('returns true for every ignored subtype', () => {
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'thinking_tokens' })).toBe(true);
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'task_progress' })).toBe(true);
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'commands_changed' })).toBe(true);
    });

    it('returns true for any system message flagged skip_transcript', () => {
      expect(
        isIgnoredSystemMessage({ type: 'system', subtype: 'task_started', skip_transcript: true })
      ).toBe(true);
    });

    it('returns false for system messages we render', () => {
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'init' })).toBe(false);
      expect(isIgnoredSystemMessage({ type: 'system', subtype: 'notification' })).toBe(false);
      expect(isIgnoredSystemMessage({ type: 'system' })).toBe(false);
    });

    it('returns false for non-system messages and non-objects', () => {
      expect(isIgnoredSystemMessage({ type: 'assistant' })).toBe(false);
      expect(isIgnoredSystemMessage({ subtype: 'thinking_tokens' })).toBe(false);
      expect(isIgnoredSystemMessage(null)).toBe(false);
      expect(isIgnoredSystemMessage(undefined)).toBe(false);
      expect(isIgnoredSystemMessage('thinking_tokens')).toBe(false);
    });
  });

  describe('parseRetryState', () => {
    it('extracts retry state from an api_retry message', () => {
      expect(
        parseRetryState({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 1184.18,
          error_status: 529,
          error: 'overloaded',
          session_id: 'sess',
          uuid: 'u1',
        })
      ).toEqual({ attempt: 2, maxRetries: 10, errorStatus: 529, error: 'overloaded' });
    });

    it('leaves optional fields undefined when absent', () => {
      expect(
        parseRetryState({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 5 })
      ).toEqual({ attempt: 1, maxRetries: 5, errorStatus: undefined, error: undefined });
    });

    it('accepts a null error_status (connection error / timeout) as undefined', () => {
      // The SDK sends error_status: null for connection errors with no HTTP
      // response; this must parse rather than failing the whole object.
      expect(
        parseRetryState({
          type: 'system',
          subtype: 'api_retry',
          attempt: 4,
          max_retries: 10,
          error_status: null,
          error: 'unknown',
        })
      ).toEqual({ attempt: 4, maxRetries: 10, errorStatus: undefined, error: 'unknown' });
    });

    it('returns null for non-retry messages', () => {
      expect(parseRetryState({ type: 'system', subtype: 'notification' })).toBeNull();
      expect(parseRetryState({ type: 'assistant' })).toBeNull();
      expect(parseRetryState(null)).toBeNull();
      // Missing required attempt/max_retries fields.
      expect(parseRetryState({ type: 'system', subtype: 'api_retry' })).toBeNull();
    });
  });

  describe('formatRetryReason', () => {
    it('maps canonical SDK error codes to friendly labels', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'overloaded' })).toBe(
        'overloaded'
      );
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'rate_limit' })).toBe(
        'rate limited'
      );
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'server_error' })).toBe(
        'server error'
      );
    });

    it('falls back to HTTP status when no error code matches', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, errorStatus: 529 })).toBe(
        'overloaded'
      );
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, errorStatus: 429 })).toBe(
        'rate limited'
      );
    });

    it('humanizes other known error codes', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'model_not_found' })).toBe(
        'model not found'
      );
    });

    it('returns null when nothing is known', () => {
      expect(formatRetryReason({ attempt: 1, maxRetries: 10 })).toBeNull();
      expect(formatRetryReason({ attempt: 1, maxRetries: 10, error: 'unknown' })).toBeNull();
    });
  });

  describe('initSessionId', () => {
    it('reads the conversation id from a system init message', () => {
      const init = {
        type: 'system',
        subtype: 'init',
        cwd: '/w',
        session_id: 'after-clear',
        model: 'claude-opus-5-5',
      };
      expect(initSessionId(init)).toBe('after-clear');
    });

    it('ignores every other message, even ones carrying a session_id', () => {
      expect(initSessionId({ type: 'result', subtype: 'success', session_id: 's' })).toBeNull();
      expect(initSessionId({ type: 'system', subtype: 'status', session_id: 's' })).toBeNull();
      expect(initSessionId(null)).toBeNull();
    });
  });
});

describe('getParentToolUseId', () => {
  it('returns the parent id for a subagent message', () => {
    expect(getParentToolUseId({ parent_tool_use_id: 'task-1' })).toBe('task-1');
  });

  it('returns null for top-level messages and non-objects', () => {
    expect(getParentToolUseId({ parent_tool_use_id: null })).toBeNull();
    expect(getParentToolUseId({})).toBeNull();
    expect(getParentToolUseId(undefined)).toBeNull();
    expect(getParentToolUseId('string')).toBeNull();
  });

  describe('parseInjectedOrigin', () => {
    it('names a peer by its display name and keeps the stripped body', () => {
      expect(
        parseInjectedOrigin({
          kind: 'peer',
          from: 'uds:/x.sock',
          name: 'math-opus-1a2b',
          body: 'hi',
        })
      ).toEqual({ sender: 'math-opus-1a2b', peerAgentName: 'math-opus-1a2b', body: 'hi' });
    });

    it('names a channel by its server', () => {
      expect(parseInjectedOrigin({ kind: 'channel', server: 'slack' })).toEqual({
        sender: 'slack',
        peerAgentName: null,
        body: null,
      });
    });

    it('falls back to the socket address, then a generic sender', () => {
      expect(parseInjectedOrigin({ kind: 'peer', from: 'uds:/x.sock' })?.sender).toBe(
        'uds:/x.sock'
      );
      expect(parseInjectedOrigin({ kind: 'peer' })?.sender).toBe('another session');
      expect(parseInjectedOrigin({ kind: 'peer', from: 'uds:/x.sock' })?.peerAgentName).toBeNull();
    });

    it('rejects prompts we sent and anything malformed', () => {
      expect(parseInjectedOrigin(undefined)).toBeNull();
      expect(parseInjectedOrigin({ kind: 'human' })).toBeNull();
      expect(parseInjectedOrigin({ kind: 'peer', name: 5 })).toBeNull();
    });
  });

  describe('isEchoOfPushedPrompt', () => {
    const pushed = new Set(['ours']);
    const user = (m: Record<string, unknown>) => ({ type: 'user', ...m }) as unknown as SDKMessage;

    it('matches the replay of a prompt we pushed', () => {
      expect(isEchoOfPushedPrompt(user({ isReplay: true, uuid: 'ours' }), pushed)).toBe(true);
    });

    it('keeps other replays: slash-command output and messages from other sessions', () => {
      expect(isEchoOfPushedPrompt(user({ isReplay: true, uuid: 'cli-output' }), pushed)).toBe(
        false
      );
      expect(
        isEchoOfPushedPrompt(
          user({ isReplay: true, uuid: 'peer', origin: { kind: 'peer', from: 'x' } }),
          pushed
        )
      ).toBe(false);
    });

    it('ignores messages that are not replays', () => {
      expect(isEchoOfPushedPrompt(user({ uuid: 'ours' }), pushed)).toBe(false);
    });
  });
});
