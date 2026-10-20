import { describe, it, expect } from 'vitest';
import {
  createdPullRequests,
  isPrSnapshotStale,
  mayChangeBranchOrPr,
  parsePullRequestJson,
  reusableChecks,
  rollUpChecks,
  settleChecks,
  NO_CHECKS_GRACE_MS,
  MERGED_PR_SNAPSHOT_TTL_MS,
  PR_SNAPSHOT_TTL_MS,
  type PrRefreshCandidate,
  type PullRequestInfo,
} from './pull-request';

const pr: PullRequestInfo = {
  number: 3,
  title: 'T',
  state: 'open',
  draft: true,
  url: 'https://github.com/o/r/pull/3',
  author: 'a',
  updatedAt: '2024-01-01T00:00:00Z',
  headBranch: 'feature',
  headSha: 'abc',
  stackedOn: null,
  checks: 'pending',
};

describe('pull-request JSON column', () => {
  it('round-trips a PR', () => {
    expect(parsePullRequestJson(JSON.stringify(pr))).toEqual(pr);
  });

  it('reads null, malformed JSON and wrong shapes as "no PR"', () => {
    expect(parsePullRequestJson(null)).toBeNull();
    expect(parsePullRequestJson('{oops')).toBeNull();
    expect(parsePullRequestJson(JSON.stringify({ number: 'x' }))).toBeNull();
    expect(parsePullRequestJson(JSON.stringify({ ...pr, state: 'weird' }))).toBeNull();
  });
});

describe('reusableChecks', () => {
  const { checks: _checks, ...fetched } = pr;
  const merged = { ...fetched, state: 'merged' as const };

  it('keeps a finished PR’s checks for the same head commit', () => {
    expect(reusableChecks(merged, { ...pr, checks: 'failure' })).toBe('failure');
    expect(reusableChecks(merged, { ...pr, checks: null })).toBeNull();
  });

  it('always refetches an open PR’s checks, which can change without a push', () => {
    expect(reusableChecks(fetched, { ...pr, checks: 'success' })).toBeUndefined();
    expect(reusableChecks(fetched, { ...pr, checks: 'none' })).toBeUndefined();
  });

  it('refetches for a new head commit or a PR never stored', () => {
    expect(reusableChecks({ ...merged, headSha: 'new' }, { ...pr, checks: 'success' })).toBe(
      undefined
    );
    expect(reusableChecks(merged, null)).toBeUndefined();
  });
});

describe('settleChecks', () => {
  const updatedAt = '2024-01-01T00:00:00Z';
  const updatedMs = Date.parse(updatedAt);

  it('reads "no checks" just after the PR changed as pending', () => {
    expect(settleChecks('none', updatedAt, updatedMs + 1000)).toBe('pending');
    expect(settleChecks('none', updatedAt, updatedMs + NO_CHECKS_GRACE_MS)).toBe('none');
  });

  it('leaves every other result alone', () => {
    expect(settleChecks('success', updatedAt, updatedMs)).toBe('success');
    expect(settleChecks(null, updatedAt, updatedMs)).toBeNull();
  });
});

describe('rollUpChecks', () => {
  const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });

  it('is none without any checks', () => {
    expect(rollUpChecks([], [])).toBe('none');
  });

  it('passes when every run and status passed', () => {
    expect(
      rollUpChecks(
        [run('completed', 'success'), run('completed', 'skipped'), run('completed', 'neutral')],
        [{ state: 'success' }]
      )
    ).toBe('success');
  });

  it('is pending while anything runs', () => {
    expect(rollUpChecks([run('completed', 'success'), run('in_progress')], [])).toBe('pending');
    expect(rollUpChecks([], [{ state: 'pending' }])).toBe('pending');
  });

  it('fails as soon as anything failed, even with checks still running', () => {
    expect(rollUpChecks([run('queued'), run('completed', 'failure')], [])).toBe('failure');
    expect(rollUpChecks([run('completed', 'timed_out')], [])).toBe('failure');
    expect(rollUpChecks([], [{ state: 'error' }])).toBe('failure');
  });

  it('treats an unknown conclusion as a failure', () => {
    expect(rollUpChecks([run('completed', 'something_new')], [])).toBe('failure');
  });
});

describe('isPrSnapshotStale', () => {
  const now = new Date('2024-01-01T12:00:00Z').getTime();
  const fresh = new Date(now - PR_SNAPSHOT_TTL_MS + 1000);
  const old = new Date(now - 60 * 60 * 1000);

  const candidate = (overrides: Partial<PrRefreshCandidate> = {}): PrRefreshCandidate => ({
    id: 's1',
    status: 'running',
    repoUrl: 'https://github.com/o/r.git',
    currentBranch: 'feature',
    pullRequest: pr,
    prCheckedAt: fresh,
    ...overrides,
  });

  it('is stale once the snapshot ages past the TTL', () => {
    expect(isPrSnapshotStale(candidate(), now)).toBe(false);
    expect(isPrSnapshotStale(candidate({ prCheckedAt: old }), now)).toBe(true);
  });

  it('is stale exactly at the TTL boundary', () => {
    const atTtl = new Date(now - PR_SNAPSHOT_TTL_MS);
    expect(isPrSnapshotStale(candidate({ prCheckedAt: atTtl }), now)).toBe(true);
  });

  it('never polls an archived session — its transcript is read-only history', () => {
    expect(isPrSnapshotStale(candidate({ status: 'archived', prCheckedAt: old }), now)).toBe(false);
  });

  it('refreshes a session that has never been checked', () => {
    expect(isPrSnapshotStale(candidate({ prCheckedAt: null }), now)).toBe(true);
  });

  it('refreshes a stale session that has no PR yet', () => {
    expect(isPrSnapshotStale(candidate({ pullRequest: null, prCheckedAt: old }), now)).toBe(true);
  });

  it('gives a merged PR a long TTL — the branch can still get a second one', () => {
    const merged = { ...pr, state: 'merged' as const };
    expect(isPrSnapshotStale(candidate({ pullRequest: merged, prCheckedAt: old }), now)).toBe(
      false
    );

    const ancient = new Date(now - MERGED_PR_SNAPSHOT_TTL_MS - 1000);
    expect(isPrSnapshotStale(candidate({ pullRequest: merged, prCheckedAt: ancient }), now)).toBe(
      true
    );
  });

  it('still refreshes a closed PR, which can be reopened', () => {
    const closed = { ...pr, state: 'closed' as const };
    expect(isPrSnapshotStale(candidate({ pullRequest: closed, prCheckedAt: old }), now)).toBe(true);
  });

  it('skips sessions with nothing to look up', () => {
    expect(isPrSnapshotStale(candidate({ repoUrl: null, prCheckedAt: old }), now)).toBe(false);
    expect(isPrSnapshotStale(candidate({ currentBranch: null, prCheckedAt: old }), now)).toBe(
      false
    );
  });
});

describe('mayChangeBranchOrPr', () => {
  const bash = (command: string) => mayChangeBranchOrPr('Bash', { command });

  it.each([
    'git checkout -b feature',
    'git switch main',
    'git push -u origin HEAD',
    'git -C repo push',
    'git add . && git commit -m x && git push',
    'git merge origin/main',
    'gh pr create --title T --body B',
    'gh pr merge 12 --squash',
    'gh pr ready',
    'gh pr new',
    'gh pr checkout 12',
    'gh -R owner/repo pr create --fill',
    'git branch -m renamed',
  ])('matches %s', (command) => {
    expect(bash(command)).toBe(true);
  });

  it.each([
    'git status',
    'git diff HEAD',
    'git log --oneline',
    'gh pr view 12',
    'gh pr checks',
    'pnpm test:run',
    'echo git; push',
    'git branch -a',
  ])('ignores %s', (command) => {
    expect(bash(command)).toBe(false);
  });

  it('matches GitHub MCP tools that change a PR', () => {
    expect(mayChangeBranchOrPr('mcp__GitHub__create_pull_request', {})).toBe(true);
    expect(mayChangeBranchOrPr('mcp__github__merge_pull_request', {})).toBe(true);
    expect(mayChangeBranchOrPr('mcp__GitHub__update_pull_request_branch', {})).toBe(true);
    expect(mayChangeBranchOrPr('mcp__GitHub__pull_request_read', {})).toBe(false);
  });

  it('ignores backgrounded Bash, whose hook fires before the command runs', () => {
    expect(mayChangeBranchOrPr('Bash', { command: 'git push', run_in_background: true })).toBe(
      false
    );
  });

  it('ignores non-Bash tools and malformed Bash input', () => {
    expect(mayChangeBranchOrPr('Read', { command: 'git push' })).toBe(false);
    expect(mayChangeBranchOrPr('Bash', { cmd: 'git push' })).toBe(false);
  });
});

describe('createdPullRequests', () => {
  it('reads the PR URL gh pr create prints, in any repo', () => {
    expect(
      createdPullRequests(
        'Bash',
        { command: 'git push -u origin HEAD && gh -R Other/Repo pr create --fill' },
        { stdout: 'https://github.com/Other/Repo/pull/42\n', stderr: '' }
      )
    ).toEqual([{ repoFullName: 'Other/Repo', number: 42 }]);
  });

  it('reads the PR URL from the GitHub MCP tool, once per PR', () => {
    const url = 'https://github.com/o/r.js/pull/7';
    expect(
      createdPullRequests('mcp__GitHub__create_pull_request', {}, [
        { type: 'text', text: JSON.stringify({ url, html_url: url }) },
      ])
    ).toEqual([{ repoFullName: 'o/r.js', number: 7 }]);
  });

  it('ignores PRs a tool only mentions without creating them', () => {
    const response = { stdout: 'https://github.com/o/r/pull/7' };
    expect(createdPullRequests('Bash', { command: 'gh pr view 7' }, response)).toEqual([]);
    expect(createdPullRequests('mcp__GitHub__pull_request_read', {}, response)).toEqual([]);
    expect(createdPullRequests('Read', { command: 'gh pr create' }, response)).toEqual([]);
  });

  it('ignores the link git push suggests for a branch with no PR yet', () => {
    expect(
      createdPullRequests(
        'Bash',
        { command: 'git push && gh pr create --fill' },
        { stderr: 'remote:   https://github.com/o/r/pull/new/feat\n', stdout: '' }
      )
    ).toEqual([]);
  });
});
