import { describe, it, expect } from 'vitest';
import {
  isPrSnapshotStale,
  parsePullRequestJson,
  serializePullRequest,
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
};

describe('pull-request JSON column', () => {
  it('round-trips a PR', () => {
    expect(parsePullRequestJson(serializePullRequest(pr))).toEqual(pr);
  });

  it('serializes "no PR" as null', () => {
    expect(serializePullRequest(null)).toBeNull();
  });

  it('reads null, malformed JSON and wrong shapes as "no PR"', () => {
    expect(parsePullRequestJson(null)).toBeNull();
    expect(parsePullRequestJson('{oops')).toBeNull();
    expect(parsePullRequestJson(JSON.stringify({ number: 'x' }))).toBeNull();
    expect(parsePullRequestJson(JSON.stringify({ ...pr, state: 'weird' }))).toBeNull();
  });
});

describe('isPrSnapshotStale', () => {
  const now = new Date('2024-01-01T12:00:00Z').getTime();
  const fresh = new Date(now - 60 * 1000);
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
