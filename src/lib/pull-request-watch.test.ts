import { describe, it, expect } from 'vitest';
import type { PullRequestInfo } from './pull-request';
import {
  commentExcerpt,
  describePullRequestState,
  formatWatchMessage,
  formatWatchedPullRequest,
  watchEventKey,
  type PullRequestComment,
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
  stackedOn: null,
  checks: 'success',
};

describe('watchEventKey', () => {
  const repoWatch = { includeDrafts: false };

  it('reports a ready PR once per head commit and CI outcome', () => {
    expect(watchEventKey(pr, repoWatch)).toBe('ready:0123456789abcdef:success');
    expect(watchEventKey({ ...pr, checks: 'failure' }, repoWatch)).toBe(
      'ready:0123456789abcdef:failure'
    );
    expect(watchEventKey({ ...pr, headSha: 'fff' }, repoWatch)).toBe('ready:fff:success');
    expect(watchEventKey({ ...pr, checks: 'none' }, repoWatch)).toBe('ready:0123456789abcdef:none');
  });

  it('waits while the PR is a draft or CI is still running', () => {
    expect(watchEventKey({ ...pr, draft: true }, repoWatch)).toBeNull();
    expect(watchEventKey({ ...pr, checks: 'pending' }, repoWatch)).toBeNull();
  });

  it('reports a draft’s finished CI when watching that one PR', () => {
    const draft = { ...pr, draft: true };
    expect(watchEventKey(draft, { includeDrafts: true })).toBe('ready:0123456789abcdef:success');
    expect(watchEventKey({ ...draft, checks: 'pending' }, { includeDrafts: true })).toBeNull();
  });

  it('reports a PR whose checks the token can’t read rather than never reporting it', () => {
    expect(watchEventKey({ ...pr, checks: null }, repoWatch)).toBe(
      'ready:0123456789abcdef:unknown'
    );
  });

  it('reports merges and closes, whatever the checks or draft state', () => {
    expect(watchEventKey({ ...pr, state: 'merged', checks: 'pending' }, repoWatch)).toBe('merged');
    expect(watchEventKey({ ...pr, state: 'closed', draft: true }, repoWatch)).toBe('closed');
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
        {
          id: 's1',
          name: 'Fix feeds',
          status: 'running',
          agentName: 'fix-feeds-ab12',
          turnActive: false,
        },
        { id: 's2', name: 'Old try', status: 'archived', agentName: null, turnActive: false },
      ],
      comments: [],
    });

    expect(text).toBe(
      [
        '- o/r#12 "Fix \\"feeds\\"" by me: ready for review, CI passed (head 0123456, updated 2024-01-01) https://github.com/o/r/pull/12',
        '  From session "Fix feeds" (s1, running, idle); message it with SendMessage to "fix-feeds-ab12".',
        '  From session "Old try" (s2, archived).',
      ].join('\n')
    );
  });

  it('shows the day GitHub last saw activity on the PR', () => {
    const text = formatWatchedPullRequest({
      repoFullName: 'o/r',
      info: { ...pr, updatedAt: '2026-09-27T23:59:59Z' },
      sessions: [],
      comments: [],
    });
    expect(text).toContain('2026-09-27');
  });

  it('names the base branch only when the PR is stacked on another', () => {
    const stacked = (stackedOn: string | null) =>
      formatWatchedPullRequest({
        repoFullName: 'o/r',
        info: { ...pr, stackedOn },
        sessions: [],
        comments: [],
      });
    expect(stacked('feature-a')).toContain('stacked on feature-a');
    expect(stacked(null)).not.toContain('stacked');
  });

  it('says whether a running author session is mid-turn', () => {
    const author = (turnActive: boolean) =>
      formatWatchedPullRequest({
        repoFullName: 'o/r',
        info: pr,
        sessions: [{ id: 's1', name: 'Fix', status: 'running', agentName: null, turnActive }],
        comments: [],
      });
    expect(author(true)).toMatch(/\bbusy\b/);
    expect(author(false)).toMatch(/\bidle\b/);
  });
});

const comment: PullRequestComment = {
  key: 'comment:1',
  number: 12,
  author: 'brendan',
  association: 'OWNER',
  path: null,
  body: 'Closing: considering removing this feature entirely.',
  url: 'https://github.com/o/r/pull/12#issuecomment-1',
  createdAt: '2024-01-02T00:00:00Z',
};

describe('commentExcerpt', () => {
  it('keeps the first few non-blank lines and marks the rest', () => {
    expect(commentExcerpt('one\n\ntwo\nthree\nfour')).toEqual(['one', 'two', 'three', '…']);
    expect(commentExcerpt('one\ntwo')).toEqual(['one', 'two']);
  });

  it('cuts a very long line short', () => {
    const [line] = commentExcerpt('x'.repeat(5000));
    expect(line.length).toBeLessThan(1000);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('formatWatchedPullRequest comments', () => {
  it('quotes each comment under its PR with who wrote it and where', () => {
    const text = formatWatchedPullRequest({
      repoFullName: 'o/r',
      info: pr,
      sessions: [],
      comments: [comment, { ...comment, key: 'review-comment:2', path: 'src/a.ts', body: 'nit' }],
    });
    expect(text).toContain('brendan');
    expect(text).toContain('considering removing this feature entirely');
    expect(text).toContain('src/a.ts');
    expect(text).toContain(comment.url);
  });
});

describe('formatWatchMessage', () => {
  it('says quoted comments are from GitHub, only when there are some', () => {
    const withComment = formatWatchMessage([
      { repoFullName: 'o/r', info: pr, sessions: [], comments: [comment] },
    ]);
    const without = formatWatchMessage([
      { repoFullName: 'o/r', info: pr, sessions: [], comments: [] },
    ]);
    expect(withComment).toMatch(/quoted from GitHub/);
    expect(without).not.toMatch(/quoted/);
  });

  it('says it comes from the watcher, not the user', () => {
    const text = formatWatchMessage([
      { repoFullName: 'o/r', info: pr, sessions: [], comments: [] },
    ]);
    expect(text).toMatch(/^\[From a pull request watch .*not from the user\.\]\n\n- o\/r#12/);
  });
});
