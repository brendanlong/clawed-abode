import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import type { PullRequestInfo } from '@/lib/pull-request';
import { PR_SNAPSHOT_TTL_MS } from '@/lib/pull-request';

const mockSseEvents = { emitSessionUpdate: vi.fn() };
vi.mock('./events', () => ({ sseEvents: mockSseEvents }));

vi.mock('./github', () => ({ fetchPullRequestForBranch: vi.fn() }));

const pr: PullRequestInfo = {
  number: 7,
  title: 'A PR',
  state: 'open',
  draft: false,
  url: 'https://github.com/o/r/pull/7',
  author: 'someone',
  updatedAt: '2024-01-01T00:00:00Z',
};

// Imported after setupTestDb: both modules reach @/lib/prisma at load time.
let fetchPullRequestForBranch: typeof import('./github').fetchPullRequestForBranch;
let refreshStalePullRequests: typeof import('./session-branch-pr').refreshStalePullRequests;

async function createSession(overrides: { prCheckedAt?: Date; pullRequest?: string } = {}) {
  return testPrisma.session.create({
    data: {
      name: 'T',
      repoPath: 'r',
      status: 'running',
      repoUrl: 'https://github.com/o/r.git',
      currentBranch: 'feat-a',
      ...overrides,
    },
  });
}

/** The row shape the routers hand to refreshStalePullRequests. */
async function candidate(id: string) {
  const row = await testPrisma.session.findUniqueOrThrow({ where: { id } });
  return {
    id: row.id,
    repoUrl: row.repoUrl,
    currentBranch: row.currentBranch,
    pullRequest: row.pullRequest ? (JSON.parse(row.pullRequest) as PullRequestInfo) : null,
    prCheckedAt: row.prCheckedAt,
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timed out waiting');
}

describe('refreshStalePullRequests', () => {
  beforeAll(async () => {
    await setupTestDb();
    ({ fetchPullRequestForBranch } = await import('./github'));
    ({ refreshStalePullRequests } = await import('./session-branch-pr'));
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await clearTestDb();
    vi.clearAllMocks();
    vi.mocked(fetchPullRequestForBranch).mockResolvedValue(pr);
  });

  it('fetches and stores a PR for a session that has never been checked', async () => {
    const session = await createSession();

    refreshStalePullRequests([await candidate(session.id)]);

    await waitFor(async () => (await candidate(session.id)).pullRequest !== null);
    const row = await testPrisma.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(JSON.parse(row.pullRequest!)).toEqual(pr);
    expect(row.prCheckedAt).not.toBeNull();
    expect(fetchPullRequestForBranch).toHaveBeenCalledWith('o/r', 'feat-a');
    expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves a snapshot inside the TTL alone', async () => {
    const session = await createSession({
      prCheckedAt: new Date(),
      pullRequest: JSON.stringify(pr),
    });

    refreshStalePullRequests([await candidate(session.id)]);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchPullRequestForBranch).not.toHaveBeenCalled();
  });

  it('stamps prCheckedAt when the lookup fails, so a 403 repo costs one call per TTL', async () => {
    vi.mocked(fetchPullRequestForBranch).mockResolvedValue(undefined);
    const session = await createSession();

    refreshStalePullRequests([await candidate(session.id)]);

    await waitFor(async () => (await candidate(session.id)).prCheckedAt !== null);
    const refreshed = await candidate(session.id);
    expect(refreshed.pullRequest).toBeNull();
    // The failure left no client-visible change, so nothing to announce.
    expect(mockSseEvents.emitSessionUpdate).not.toHaveBeenCalled();

    refreshStalePullRequests([refreshed]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchPullRequestForBranch).toHaveBeenCalledTimes(1);
  });

  it('makes one call when the same stale session appears twice concurrently', async () => {
    const session = await createSession();
    const row = await candidate(session.id);

    refreshStalePullRequests([row]);
    refreshStalePullRequests([row]);

    await waitFor(async () => (await candidate(session.id)).pullRequest !== null);
    expect(fetchPullRequestForBranch).toHaveBeenCalledTimes(1);
  });

  it('announces a PR whose state changed under us', async () => {
    const session = await createSession({
      prCheckedAt: new Date(Date.now() - PR_SNAPSHOT_TTL_MS - 1000),
      pullRequest: JSON.stringify(pr),
    });
    vi.mocked(fetchPullRequestForBranch).mockResolvedValue({ ...pr, state: 'closed' });

    refreshStalePullRequests([await candidate(session.id)]);

    await waitFor(async () => (await candidate(session.id)).pullRequest?.state === 'closed');
    expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalledTimes(1);
  });

  it('skips a session with no repo or no branch', async () => {
    const noRepo = await testPrisma.session.create({
      data: { name: 'T', repoPath: '', status: 'running' },
    });

    refreshStalePullRequests([await candidate(noRepo.id)]);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchPullRequestForBranch).not.toHaveBeenCalled();
  });
});
