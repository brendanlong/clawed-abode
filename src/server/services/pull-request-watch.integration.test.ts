import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import type { ChecksState, GitHubPullRequest } from '@/lib/pull-request';

vi.mock('./events', () => ({ sseEvents: { emitSessionUpdate: vi.fn() } }));
vi.mock('./github', () => ({
  fetchOpenPullRequests: vi.fn(),
  fetchPullRequest: vi.fn(),
  fetchPullRequestForBranch: vi.fn(),
  fetchChecks: vi.fn(),
}));

let watch: typeof import('./pull-request-watch');
let github: typeof import('./github');
let savePullRequest: typeof import('./pull-request-store').savePullRequest;

/** What GitHub currently says, keyed by PR number; tests edit it between polls. */
let remote: Map<number, GitHubPullRequest>;
let checks: Map<string, ChecksState>;
const live = new Set<string>();
/** Sessions whose query goes away between the poll's start and the delivery. */
const dropping = new Set<string>();
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
  dropping.clear();
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
    deliverMessage: async (sessionId, text) => {
      if (dropping.has(sessionId)) return false;
      delivered.push({ sessionId, text });
      return true;
    },
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

  it('sends an update again if its delivery was dropped', async () => {
    setRemote(remotePr(1));
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    checks.set('sha-1', 'success');
    dropping.add(manager.id);
    await watch._pollPullRequestWatches();
    expect(delivered).toEqual([]);

    dropping.delete(manager.id);
    await watch._pollPullRequestWatches();
    expect(delivered).toHaveLength(1);
  });

  it('reports nothing for a PR whose checks failed to load, until they load', async () => {
    setRemote(remotePr(1));
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    vi.mocked(github.fetchChecks).mockRejectedValueOnce(new Error('502'));
    await watch._pollPullRequestWatches();
    expect(delivered).toEqual([]);

    checks.set('sha-1', 'success');
    await watch._pollPullRequestWatches();
    expect(delivered.map((d) => d.text)).toEqual([expect.stringContaining('CI passed')]);
  });

  it('reports a PR closed without merging', async () => {
    setRemote(remotePr(4));
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    setRemote(remotePr(4, { state: 'closed' }));
    await watch._pollPullRequestWatches();
    expect(delivered.map((d) => d.text)).toEqual([
      expect.stringContaining('#4 "PR 4" by me: closed without merging'),
    ]);
  });

  it('reports a merge a badge lookup stored between polls', async () => {
    setRemote(remotePr(5));
    checks.set('sha-5', 'success');
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    setRemote(remotePr(5, { state: 'merged' }));
    await savePullRequest('o/r', remotePr(5, { state: 'merged' }), new Date());
    await watch._pollPullRequestWatches();

    expect(delivered.map((d) => d.text)).toEqual([
      expect.stringContaining('#5 "PR 5" by me: merged'),
    ]);
  });

  it('sends a dropped merge again once the session is back', async () => {
    setRemote(remotePr(6));
    const manager = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);

    setRemote(remotePr(6, { state: 'merged' }));
    dropping.add(manager.id);
    await watch._pollPullRequestWatches();
    dropping.delete(manager.id);
    await watch._pollPullRequestWatches();

    expect(delivered.map((d) => d.text)).toEqual([
      expect.stringContaining('#6 "PR 6" by me: merged'),
    ]);
  });
});

describe('watching one PR', () => {
  it('reports a draft’s CI without syncing the whole repo, and ends after the merge', async () => {
    setRemote(remotePr(1, { draft: true }), remotePr(2));
    checks.set('sha-2', 'success');
    const author = await createManager();

    const { watching, pullRequest } = await watch.watchPullRequest(author.id, 'o/r', 1);
    expect(watching).toBe(true);
    expect(pullRequest.info.checks).toBe('pending');

    checks.set('sha-1', 'failure');
    await watch._pollPullRequestWatches();
    expect(delivered.map((d) => d.text)).toEqual([
      expect.stringContaining('#1 "PR 1" by me: draft, CI failed'),
    ]);
    expect(github.fetchOpenPullRequests).not.toHaveBeenCalled();

    setRemote(remotePr(1, { state: 'merged' }));
    await watch._pollPullRequestWatches();
    expect(delivered[1].text).toContain('#1 "PR 1" by me: merged');
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });

  it('doesn’t watch a PR that is already finished', async () => {
    setRemote(remotePr(1, { state: 'closed' }));
    const author = await createManager();

    const { watching } = await watch.watchPullRequest(author.id, 'o/r', 1);

    expect(watching).toBe(false);
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });

  it('fails for a PR that can’t be read', async () => {
    const author = await createManager();
    await expect(watch.watchPullRequest(author.id, 'o/r', 404)).rejects.toThrow('not found');
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });

  it('stays separate from the session’s repo watches', async () => {
    setRemote(remotePr(1));
    const session = await createManager();
    await watch.watchPullRequest(session.id, 'o/r', 1);
    await watch.setPullRequestWatches(session.id, ['o/r']);
    await watch.setPullRequestWatches(session.id, []);
    expect(await testPrisma.pullRequestWatch.findMany({ select: { number: true } })).toEqual([
      { number: 1 },
    ]);

    await watch.unwatchPullRequest(session.id, 'O/R', 1);
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });

  it('reports what changed between its reply and the next poll', async () => {
    setRemote(remotePr(1));
    const author = await createManager();
    await watch.watchPullRequest(author.id, 'o/r', 1);

    setRemote(remotePr(1, { state: 'merged' }));
    await watch._pollPullRequestWatches();

    expect(delivered.map((d) => d.text)).toEqual([
      expect.stringContaining('#1 "PR 1" by me: merged'),
    ]);
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });

  it('keeps the watch when the merge couldn’t be delivered, and ends it once it is', async () => {
    setRemote(remotePr(1));
    const author = await createManager();
    await watch.watchPullRequest(author.id, 'o/r', 1);

    setRemote(remotePr(1, { state: 'merged' }));
    dropping.add(author.id);
    await watch._pollPullRequestWatches();
    expect(await testPrisma.pullRequestWatch.count()).toBe(1);

    dropping.delete(author.id);
    await watch._pollPullRequestWatches();
    expect(delivered).toHaveLength(1);
    expect(await testPrisma.pullRequestWatch.count()).toBe(0);
  });

  it('rides along on a repo another session watches, still reporting draft CI', async () => {
    setRemote(remotePr(1, { draft: true }));
    const manager = await createManager();
    const author = await createManager();
    await watch.setPullRequestWatches(manager.id, ['o/r']);
    await watch.watchPullRequest(author.id, 'o/r', 1);
    vi.mocked(github.fetchPullRequest).mockClear();

    checks.set('sha-1', 'success');
    await watch._pollPullRequestWatches();

    expect(github.fetchPullRequest).not.toHaveBeenCalled();
    expect(delivered.map((d) => d.sessionId)).toEqual([author.id]);
    expect(delivered[0].text).toContain('draft, CI passed');
  });
});

describe('findOwnPullRequest', () => {
  it('finds the PR for the session’s current branch', async () => {
    vi.mocked(github.fetchPullRequestForBranch).mockResolvedValue(remotePr(8));
    const session = await testPrisma.session.create({
      data: {
        name: 'Author',
        repoPath: 'r',
        status: 'running',
        repoUrl: 'https://github.com/o/r.git',
        currentBranch: 'branch-8',
      },
    });

    expect(await watch.findOwnPullRequest(session.id)).toEqual({ repoFullName: 'o/r', number: 8 });
    expect(github.fetchPullRequestForBranch).toHaveBeenCalledWith('o/r', 'branch-8');
  });

  it('asks for a number when the branch has no PR or the session no repo', async () => {
    vi.mocked(github.fetchPullRequestForBranch).mockResolvedValue(null);
    const withRepo = await testPrisma.session.create({
      data: {
        name: 'A',
        repoPath: 'r',
        status: 'running',
        repoUrl: 'https://github.com/o/r.git',
        currentBranch: 'b',
      },
    });
    const noRepo = await createManager();

    await expect(watch.findOwnPullRequest(withRepo.id)).rejects.toThrow('pass number');
    await expect(watch.findOwnPullRequest(noRepo.id)).rejects.toThrow('pass repo and number');
  });
});
