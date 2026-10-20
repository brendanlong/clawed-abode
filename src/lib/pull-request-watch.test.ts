import { describe, it, expect } from 'vitest';
import type { PullRequestInfo } from './pull-request';
import {
  describePullRequestState,
  formatWatchMessage,
  formatWatchedPullRequest,
  watchEventKey,
} from './pull-request-watch';

const pr: PullRequestInfo = {
  number: 12,
  title: 'Fix "feeds"',
  state: 'open',
  draft: false,
  url: 'https://github.com/o/r/pull/12',
  author: 'me',
  updatedAt: '2024-01-01T00:00:00Z',
  headBranch: 'fix-feeds',
  headSha: '0123456789abcdef',
  checks: 'success',
};

describe('watchEventKey', () => {
  it('reports a ready PR once per head commit and CI outcome', () => {
    expect(watchEventKey(pr)).toBe('ready:0123456789abcdef:success');
    expect(watchEventKey({ ...pr, checks: 'failure' })).toBe('ready:0123456789abcdef:failure');
    expect(watchEventKey({ ...pr, headSha: 'fff' })).toBe('ready:fff:success');
    expect(watchEventKey({ ...pr, checks: 'none' })).toBe('ready:0123456789abcdef:none');
  });

  it('waits while the PR is a draft or CI is still running', () => {
    expect(watchEventKey({ ...pr, draft: true })).toBeNull();
    expect(watchEventKey({ ...pr, checks: 'pending' })).toBeNull();
  });

  it('reports a PR whose checks the token can’t read rather than never reporting it', () => {
    expect(watchEventKey({ ...pr, checks: null })).toBe('ready:0123456789abcdef:unknown');
  });

  it('reports merges and closes, whatever the checks or draft state', () => {
    expect(watchEventKey({ ...pr, state: 'merged', checks: 'pending' })).toBe('merged');
    expect(watchEventKey({ ...pr, state: 'closed', draft: true })).toBe('closed');
  });
});

describe('describePullRequestState', () => {
  it('describes open PRs with their CI state', () => {
    expect(describePullRequestState(pr)).toBe('ready for review, CI passed');
    expect(describePullRequestState({ ...pr, draft: true, checks: 'pending' })).toBe(
      'draft, CI running'
    );
    expect(describePullRequestState({ ...pr, checks: null })).toBe(
      'ready for review, CI status unknown'
    );
  });

  it('describes finished PRs without CI', () => {
    expect(describePullRequestState({ ...pr, state: 'merged' })).toBe('merged');
    expect(describePullRequestState({ ...pr, state: 'closed' })).toBe('closed without merging');
  });
});

describe('formatWatchedPullRequest', () => {
  it('names the PR and the sessions that wrote it, with their addresses', () => {
    const text = formatWatchedPullRequest({
      repoFullName: 'o/r',
      info: pr,
      sessions: [
        { id: 's1', name: 'Fix feeds', status: 'running', agentName: 'fix-feeds-ab12' },
        { id: 's2', name: 'Old try', status: 'archived', agentName: null },
      ],
    });

    expect(text).toBe(
      [
        '- o/r#12 "Fix \\"feeds\\"" by me: ready for review, CI passed (head 0123456) https://github.com/o/r/pull/12',
        '  From session "Fix feeds" (s1, running); message it with SendMessage to "fix-feeds-ab12".',
        '  From session "Old try" (s2, archived).',
      ].join('\n')
    );
  });
});

describe('formatWatchMessage', () => {
  it('says it comes from the watcher, not the user', () => {
    const text = formatWatchMessage([{ repoFullName: 'o/r', info: pr, sessions: [] }]);
    expect(text).toMatch(/^\[From the pull request watcher .*not from the user\.\]\n\n- o\/r#12/);
  });
});
