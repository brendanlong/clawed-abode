import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import { waitFor } from '@/test/wait-for';
import { parsePullRequestJson, PR_SNAPSHOT_TTL_MS, type PullRequestInfo } from '@/lib/pull-request';

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

const staleCheck = new Date(Date.now() - PR_SNAPSHOT_TTL_MS - 1000);

function createSession(
  overrides: { prCheckedAt?: Date; pullRequest?: string; status?: string } = {}
) {
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
function sessionRow(id: string) {
  return testPrisma.session.findUniqueOrThrow({ where: { id } });
}

async function storedPr(id: string): Promise<PullRequestInfo | null> {
  return parsePullRequestJson((await sessionRow(id)).pullRequest);
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
    const { id } = await createSession();

    refreshStalePullRequests([await sessionRow(id)]);

    await waitFor(async () => (await storedPr(id)) !== null);
    const row = await sessionRow(id);
    expect(parsePullRequestJson(row.pullRequest)).toEqual(pr);
    expect(row.prCheckedAt).not.toBeNull();
    expect(fetchPullRequestForBranch).toHaveBeenCalledWith('o/r', 'feat-a');
    expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalledTimes(1);
  });

  it('leaves a snapshot inside the TTL alone', async () => {
    const { id } = await createSession({
      prCheckedAt: new Date(),
      pullRequest: JSON.stringify(pr),
    });

    refreshStalePullRequests([await sessionRow(id)]);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchPullRequestForBranch).not.toHaveBeenCalled();
  });

  it('never polls an archived session', async () => {
    const { id } = await createSession({ status: 'archived', prCheckedAt: staleCheck });

    refreshStalePullRequests([await sessionRow(id)]);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchPullRequestForBranch).not.toHaveBeenCalled();
  });

  it('stamps prCheckedAt when the lookup fails, so a 403 repo costs one call per TTL', async () => {
    vi.mocked(fetchPullRequestForBranch).mockResolvedValue(undefined);
    const { id } = await createSession();

    refreshStalePullRequests([await sessionRow(id)]);

    await waitFor(async () => (await sessionRow(id)).prCheckedAt !== null);
    expect(await storedPr(id)).toBeNull();
    // The failure left no client-visible change, so nothing to announce.
    expect(mockSseEvents.emitSessionUpdate).not.toHaveBeenCalled();

    refreshStalePullRequests([await sessionRow(id)]);
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchPullRequestForBranch).toHaveBeenCalledTimes(1);
  });

  it('makes one call when the same stale session appears twice concurrently', async () => {
    const { id } = await createSession();
    const row = await sessionRow(id);

    refreshStalePullRequests([row]);
    refreshStalePullRequests([row]);

    await waitFor(async () => (await storedPr(id)) !== null);
    expect(fetchPullRequestForBranch).toHaveBeenCalledTimes(1);
  });

  it('announces a PR whose state changed under us', async () => {
    const { id } = await createSession({
      prCheckedAt: staleCheck,
      pullRequest: JSON.stringify(pr),
    });
    vi.mocked(fetchPullRequestForBranch).mockResolvedValue({ ...pr, state: 'closed' });

    refreshStalePullRequests([await sessionRow(id)]);

    await waitFor(async () => (await storedPr(id))?.state === 'closed');
    expect(mockSseEvents.emitSessionUpdate).toHaveBeenCalledTimes(1);
  });

  it('discards the result when the branch moved on while GitHub was answering', async () => {
    const { id } = await createSession();
    const row = await sessionRow(id);

    let releaseFetch: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      vi.mocked(fetchPullRequestForBranch).mockImplementation(async () => {
        resolve();
        await new Promise<void>((r) => (releaseFetch = r));
        return pr;
      });
    });

    refreshStalePullRequests([row]);
    await fetchStarted;
    await testPrisma.session.update({ where: { id }, data: { currentBranch: 'feat-b' } });
    releaseFetch();

    await new Promise((r) => setTimeout(r, 50));
    // feat-a's PR must not land on feat-b's row.
    expect(await storedPr(id)).toBeNull();
    expect(mockSseEvents.emitSessionUpdate).not.toHaveBeenCalled();
  });

  it('skips a session with no repo or no branch', async () => {
    const noRepo = await testPrisma.session.create({
      data: { name: 'T', repoPath: '', status: 'running' },
    });

    refreshStalePullRequests([await sessionRow(noRepo.id)]);
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchPullRequestForBranch).not.toHaveBeenCalled();
  });

  it('caps how many GitHub calls a single page of stale sessions opens at once', async () => {
    const sessions = await Promise.all(Array.from({ length: 10 }, () => createSession()));

    let inFlight = 0;
    let peakInFlight = 0;
    const releases: (() => void)[] = [];
    vi.mocked(fetchPullRequestForBranch).mockImplementation(async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise<void>((r) => releases.push(r));
      inFlight--;
      return pr;
    });

    refreshStalePullRequests(await Promise.all(sessions.map((s) => sessionRow(s.id))));

    await waitFor(() => releases.length === 4);
    await new Promise((r) => setTimeout(r, 20));
    expect(peakInFlight).toBe(4);

    while (releases.length > 0) {
      releases.pop()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await waitFor(async () => (await storedPr(sessions[9].id)) !== null, 5000);
    expect(fetchPullRequestForBranch).toHaveBeenCalledTimes(10);
  });
});
