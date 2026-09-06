import { describe, it, expect } from 'vitest';
import { parsePullRequestJson, serializePullRequest, type PullRequestInfo } from './pull-request';

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
