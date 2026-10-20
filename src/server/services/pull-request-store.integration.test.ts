import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';
import {
  parsePullRequestJson,
  type GitHubPullRequest,
  type PullRequestInfo,
} from '@/lib/pull-request';

const mockSseEvents = { emitSessionUpdate: vi.fn() };
vi.mock('./events', () => ({ sseEvents: mockSseEvents }));

vi.mock('./github', () => ({ fetchChecks: vi.fn() }));

const fetched: GitHubPullRequest = {
  number: 7,
  title: 'A PR',
  state: 'open',
  draft: false,
  url: 'https://github.com/o/r/pull/7',
  author: 'someone',
  updatedAt: '2024-01-01T00:00:00Z',
  headBranch: 'feat-a',
  headSha: 'abc',
  stackedOn: null,
};

let savePullRequest: typeof import('./pull-request-store').savePullRequest;
let copyLinkedPullRequest: typeof import('./pull-request-store').copyLinkedPullRequest;
let fetchChecks: typeof import('./github').fetchChecks;

async function storedInfo(repoFullName: string, number: number): Promise<PullRequestInfo | null> {
  const row = await testPrisma.pullRequest.findUnique({
    where: { repoFullName_number: { repoFullName, number } },
  });
  return parsePullRequestJson(row?.info ?? null);
}

async function sessionPr(id: string): Promise<PullRequestInfo | null> {
  const row = await testPrisma.session.findUniqueOrThrow({ where: { id } });
  return parsePullRequestJson(row.pullRequest);
}

function createLinkedSession(pullRequestId: string | null, status = 'running') {
  return testPrisma.session.create({
    data: { name: 'T', repoPath: 'r', status, currentBranch: 'feat-a', pullRequestId },
  });
}

beforeAll(async () => {
  await setupTestDb();
  ({ savePullRequest, copyLinkedPullRequest } = await import('./pull-request-store'));
  ({ fetchChecks } = await import('./github'));
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await clearTestDb();
  vi.clearAllMocks();
  vi.mocked(fetchChecks).mockResolvedValue('pending');
});

describe('savePullRequest', () => {
  it('stores the PR with its head commit’s checks', async () => {
    await savePullRequest('o/r', fetched, new Date());

    expect(await storedInfo('o/r', 7)).toEqual({ ...fetched, checks: 'pending' });
    expect(fetchChecks).toHaveBeenCalledWith('o/r', 'abc');
  });

  it('keys repos case-insensitively, so a badge and a watch share one row', async () => {
    const first = await savePullRequest('Owner/Repo', fetched, new Date(1000));
    const second = await savePullRequest('owner/repo', fetched, new Date(2000));

    expect(second).toBe(first);
    expect(await testPrisma.pullRequest.count()).toBe(1);
  });

  it('copies a change to every live session linked to the PR, and only announces those', async () => {
    const id = await savePullRequest('o/r', fetched, new Date(1000));
    const a = await createLinkedSession(id);
    const b = await createLinkedSession(id);
    const archived = await createLinkedSession(id, 'archived');
    const unrelated = await createLinkedSession(null);

    vi.mocked(fetchChecks).mockResolvedValue('success');
    await savePullRequest('o/r', fetched, new Date(2000));

    expect((await sessionPr(a.id))?.checks).toBe('success');
    expect((await sessionPr(b.id))?.checks).toBe('success');
    expect(await sessionPr(archived.id)).toBeNull();
    expect(await sessionPr(unrelated.id)).toBeNull();
    const announced = mockSseEvents.emitSessionUpdate.mock.calls.map(([sessionId]) => sessionId);
    expect(announced.sort()).toEqual([a.id, b.id].sort());
  });

  it('announces nothing when the PR is unchanged', async () => {
    const id = await savePullRequest('o/r', fetched, new Date(1000));
    await createLinkedSession(id);
    await savePullRequest('o/r', fetched, new Date(2000));
    vi.clearAllMocks();

    await savePullRequest('o/r', fetched, new Date(3000));

    expect(mockSseEvents.emitSessionUpdate).not.toHaveBeenCalled();
  });

  it('never lets a lookup that started earlier overwrite a later one', async () => {
    await savePullRequest('o/r', { ...fetched, state: 'merged' }, new Date(2000));
    const id = await savePullRequest('o/r', fetched, new Date(1000));

    expect((await storedInfo('o/r', 7))?.state).toBe('merged');
    expect(id).toBe(
      (
        await testPrisma.pullRequest.findUniqueOrThrow({
          where: { repoFullName_number: { repoFullName: 'o/r', number: 7 } },
        })
      ).id
    );
  });
});

describe('copyLinkedPullRequest', () => {
  it('copies a newly linked PR onto the session and reports that it announced it', async () => {
    const id = await savePullRequest('o/r', fetched, new Date());
    const session = await createLinkedSession(id);

    expect(await copyLinkedPullRequest(session.id)).toBe(true);
    expect(await sessionPr(session.id)).toEqual({ ...fetched, checks: 'pending' });
    expect(await copyLinkedPullRequest(session.id)).toBe(false);
  });

  it('clears the copy once the session is unlinked', async () => {
    const id = await savePullRequest('o/r', fetched, new Date());
    const session = await createLinkedSession(id);
    await copyLinkedPullRequest(session.id);
    await testPrisma.session.update({ where: { id: session.id }, data: { pullRequestId: null } });

    expect(await copyLinkedPullRequest(session.id)).toBe(true);
    expect(await sessionPr(session.id)).toBeNull();
  });
});

describe('savePullRequest checks', () => {
  it('keeps a finished PR’s checks instead of refetching them, but refetches an open one’s', async () => {
    vi.mocked(fetchChecks).mockResolvedValue('success');
    await savePullRequest('o/r', fetched, new Date(1000));
    await savePullRequest('o/r', fetched, new Date(2000));
    expect(fetchChecks).toHaveBeenCalledTimes(2);
    vi.mocked(fetchChecks).mockClear();

    await savePullRequest('o/r', { ...fetched, state: 'merged' }, new Date(3000));
    expect(fetchChecks).not.toHaveBeenCalled();
    expect((await storedInfo('o/r', 7))?.checks).toBe('success');
  });

  it('leaves the stored row alone when the checks fail to load', async () => {
    await savePullRequest('o/r', fetched, new Date(1000));
    vi.mocked(fetchChecks).mockRejectedValue(new Error('502'));

    await expect(
      savePullRequest('o/r', { ...fetched, title: 'Renamed' }, new Date(2000))
    ).rejects.toThrow('502');
    expect(await storedInfo('o/r', 7)).toEqual({ ...fetched, checks: 'pending' });
  });

  it('counts "no checks" on a just-updated PR as pending, since CI may not have registered', async () => {
    vi.mocked(fetchChecks).mockResolvedValue('none');
    const justPushed = { ...fetched, updatedAt: new Date().toISOString() };

    await savePullRequest('o/r', justPushed, new Date(1000));
    expect((await storedInfo('o/r', 7))?.checks).toBe('pending');

    await savePullRequest('o/r', fetched, new Date(2000));
    expect((await storedInfo('o/r', 7))?.checks).toBe('none');
  });
});
