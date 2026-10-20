import { describe, it, expect } from 'vitest';
import type { Session } from '@/generated/prisma/client';
import {
  applySessionStateEvent,
  type SessionLiveState,
  type SessionStateEvent,
  type SessionStreamState,
} from './session-stream-state';
import { toSessionView } from './session-view';

const at = new Date('2026-01-01T00:00:00Z');

function sessionRow(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'Session',
    repoUrl: null,
    branch: null,
    repoPath: '',
    status: 'running',
    statusMessage: null,
    currentBranch: null,
    pullRequest: null,
    pullRequestId: null,
    prCheckedAt: null,
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
    messageSequence: 0,
    sessionScope: null,
    claudeModel: null,
    claudeSessionId: null,
    agentName: null,
    sessionToolsEnabled: false,
    attentionAt: null,
    attentionSummary: null,
    rateLimitPauseEnabled: null,
    rateLimitPauseThreshold: null,
    resumeAfterRateLimit: false,
    queuedPromptSequence: 0,
    usageAlertFiveHour: null,
    usageAlertWeekly: null,
    ...overrides,
  };
}

const idle: SessionStreamState['live'] = {
  running: false,
  commands: [],
  retry: null,
  backgroundTasks: [],
  pendingMessageIds: [],
  queuedMessageIds: [],
  rateLimitHold: null,
};

const state: SessionStreamState = { session: toSessionView(sessionRow()), live: idle };

describe('applySessionStateEvent', () => {
  it('replaces the whole state with a snapshot, even before any state exists', () => {
    const session = toSessionView(sessionRow({ status: 'creating' }));
    const live = { ...idle, running: true };
    const snapshot = {
      kind: 'snapshot' as const,
      session,
      live,
      history: { after: -1, messages: [], hasMore: false, partials: [] },
    };
    expect(applySessionStateEvent(undefined, snapshot)).toEqual({ session, live });
    expect(applySessionStateEvent(state, snapshot)).toEqual({ session, live });
  });

  it('replaces the session row on a session event, keeping live state', () => {
    const live = { ...idle, running: true };
    const session = toSessionView(sessionRow({ name: 'Renamed' }));
    expect(applySessionStateEvent({ ...state, live }, { kind: 'session', session })).toEqual({
      session,
      live,
    });
  });

  it('sets the one live field each latest-value event carries', () => {
    const hold = {
      untilMs: 1,
      limitType: 'five_hour' as const,
      reason: 'threshold' as const,
      utilization: 97,
    };
    const command = { name: 'review', description: 'Review', argumentHint: '' };
    const cases: [SessionStateEvent, Partial<SessionLiveState>][] = [
      [{ kind: 'running', running: true }, { running: true }],
      [{ kind: 'commands', commands: [command] }, { commands: [command] }],
      [
        { kind: 'retry', retry: { attempt: 1, maxRetries: 3, error: 'overloaded' } },
        { retry: { attempt: 1, maxRetries: 3, error: 'overloaded' } },
      ],
      [
        {
          kind: 'background',
          tasks: [{ taskId: 't', taskType: 'local_agent', description: 'd', ambient: false }],
        },
        {
          backgroundTasks: [
            { taskId: 't', taskType: 'local_agent', description: 'd', ambient: false },
          ],
        },
      ],
      [{ kind: 'pending', messageIds: ['p'] }, { pendingMessageIds: ['p'] }],
      [{ kind: 'queued', messageIds: ['q'] }, { queuedMessageIds: ['q'] }],
      [{ kind: 'rate_limit', hold }, { rateLimitHold: hold }],
    ];
    for (const [event, patch] of cases) {
      expect(applySessionStateEvent(state, event)).toEqual({
        ...state,
        live: { ...idle, ...patch },
      });
    }
  });

  it('has nothing to patch before the first snapshot', () => {
    expect(applySessionStateEvent(undefined, { kind: 'running', running: true })).toBeUndefined();
  });
});
