import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import type { ChecksState, GitHubPullRequest } from '@/lib/pull-request';

vi.mock('./events', () => ({ sseEvents: { emitSessionUpdate: vi.fn() } }));
vi.mock('./github', () => ({
  fetchOpenPullRequests: vi.fn(),
  fetchPullRequest: vi.fn(),
  fetchChecks: vi.fn(),
}));

let watch: typeof import('./pull-request-watch');
let github: typeof import('./github');
let savePullRequest: typeof import('./pull-request-store').savePullRequest;

/** What GitHub currently says, keyed by PR number; tests edit it between polls. */
let remote: Map<number, GitHubPullRequest>;
let checks: Map<string, ChecksState>;
const live = new Set<string>();
const delivered: { sessionId: string; text: string }[] = [];

function remotePr(number: number, overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    number,
    title: `PR ${number}`,
    state: 'open',
    draft: false,
    url: `https://github.com/o/r/pull/${number}`,
    author: 'me',
    updatedAt: '2024-01-01T00:00:00Z',
    headBranch: `branch-${number}`,
    headSha: `sha-${number}`,
    ...overrides,
  };
}

function setRemote(...prs: GitHubPullRequest[]) {
  remote = new Map(prs.map((pr) => [pr.number, pr]));
}

async function createManager() {
  const session = await testPrisma.session.create({
    data: { name: 'Manager', repoPath: '', status: 'running', agentName: 'manager-1' },
  });
  live.add(session.id);
  return session;
}

beforeAll(async () => {
  await setupTestDb();
  watch = await import('./pull-request-watch');
  github = await import('./github');
  ({ savePullRequest } = await import('./pull-request-store'));
});

afterAll(async () => {
  watch._resetPullRequestWatchState();
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  vi.clearAllMocks();
  live.clear();
  delivered.length = 0;
  setRemote();
  checks = new Map();
  vi.mocked(github.fetchOpenPullRequests).mockImplementation(async () =>
    [...remote.values()].filter((pr) => pr.state === 'open')
  );
  vi.mocked(github.fetchPullRequest).mockImplementation(async (_repo, number) => {
    const pr = remote.get(number);
    if (!pr) throw new Error('not found');
    return pr;
  });
  vi.mocked(github.fetchChecks).mockImplementation(
    async (_repo, sha) => checks.get(sha) ?? 'pending'
  );
  watch._resetPullRequestWatchState();
  watch.initPullRequestWatch({
    hasLiveQuery: (sessionId) => live.has(sessionId),
    deliverMessage: async (sessionId, text) => void delivered.push({ sessionId, text }),
  });
});

describe('setPullRequestWatches', () => {
  it('returns the open PRs with the sessions that wrote them, without reporting them as news', async () => {
    setRemote(remotePr(1), remotePr(2, { state: 'merged' }));
    checks.set('sha-1', 'success');
    const manager = await createManager();
    const prId = await savePullRequest('o/r', remotePr(1), new Date(0));
    await testPrisma.session.create({
      data: {
        name: 'Author',
        repoPath: 'r',
        status: 'running',
        agentName: 'author-1',
        pullRequestId: prId,
      },
    });

    const open = await watch.setPullRequestWatches(manager.id, ['O/R']);

    expect(open.map((pr) => pr.info.number)).toEqual([1]);
    expect(open[0].info.checks).toBe('success');
    expect(open[0].sessions.map((s) => s.agentName)).toEqual(['author-1']);
    await watch._pollPullRequestWatches();
    expect(delivered).toEqual([]);
  });

  it('fails without watching when the repo can’t be read', async () => {
    const manager = await createManager();
    vi.mocked(github.fetchOpenPullRequests).mockRejectedValue(new Error('404'));

    await expect(watch.setPullRequestWatches(manager.id, ['o/private'])).rejects.toThrow('404');
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });

  it('replaces the list, and [] stops watching', async () => {
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/a', 'o/b']);
    await watch.setPullRequestWatches(manager.id, ['o/b']);
    const repos = await testPrisma.pullRequestWatch.findMany({ select: { repoFullName: true } });
    expect(repos.map((w) => w.repoFullName)).toEqual(['o/b']);

    await watch.setPullRequestWatches(manager.id, []);
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });
});

describe('polling', () => {
  it('reports a PR once when its CI finishes, and again for a new push', async () => {
    setRemote(remotePr(1));
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    await watch._pollPullRequestWatches();
    expect(delivered).toEqual([]);

    checks.set('sha-1', 'failure');
    await watch._pollPullRequestWatches();
    await watch._pollPullRequestWatches();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].sessionId).toBe(manager.id);
    expect(delivered[0].text).toContain('o/r#1 "PR 1" by me: ready for review, CI failed');

    setRemote(remotePr(1, { headSha: 'sha-1b' }));
    checks.set('sha-1b', 'success');
    await watch._pollPullRequestWatches();
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text).toContain('CI passed (head sha-1b)');
  });

  it('waits for a draft to be marked ready', async () => {
    setRemote(remotePr(1, { draft: true }));
    checks.set('sha-1', 'success');
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    await watch._pollPullRequestWatches();
    expect(delivered).toEqual([]);

    setRemote(remotePr(1));
    await watch._pollPullRequestWatches();
    expect(delivered).toHaveLength(1);
  });

  it('reports a new PR, and its merge once it leaves the open list', async () => {
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    setRemote(remotePr(3));
    checks.set('sha-3', 'none');
    await watch._pollPullRequestWatches();
    expect(delivered.map((d) => d.text)).toEqual([
      expect.stringContaining('#3 "PR 3" by me: ready for review, no CI checks'),
    ]);

    setRemote(remotePr(3, { state: 'merged' }));
    await watch._pollPullRequestWatches();
    expect(delivered).toHaveLength(2);
    expect(delivered[1].text).toContain('#3 "PR 3" by me: merged');
    expect(github.fetchPullRequest).toHaveBeenCalledWith('o/r', 3);
  });

  it('doesn’t report the merge of a PR it never saw open', async () => {
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);
    // A badge lookup stores an old, already-merged PR in the watched repo.
    await savePullRequest('o/r', remotePr(9, { state: 'merged' }), new Date());

    await watch._pollPullRequestWatches();
    expect(delivered).toEqual([]);
  });

  it('holds updates for a session that can’t hear them until it can', async () => {
    setRemote(remotePr(1));
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);
    live.delete(manager.id);

    checks.set('sha-1', 'success');
    await watch._pollPullRequestWatches();
    expect(delivered).toEqual([]);

    live.add(manager.id);
    await watch._pollPullRequestWatches();
    expect(delivered).toHaveLength(1);
  });
});
