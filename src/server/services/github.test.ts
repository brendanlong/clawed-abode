import { resetEnvCache } from '@/lib/env';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock('@/lib/logger', async () => (await import('@/test/mock-logger')).mockLoggerModule());

import {
  _clearConditionalGetCaches,
  ConditionalGetCache,
  fetchChecks,
  fetchOpenPullRequests,
  fetchPullRequest,
  fetchPullRequestForBranch,
  fetchRecentComments,
  fetchOpenSecurityAlerts,
  fetchSecurityAlert,
  GitHubApiError,
  githubFetchResponse,
  parseLinkHeader,
} from './github';

function createMockResponse(data: unknown, status = 200, etag: string | null = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    headers: {
      get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null),
    },
  };
}

describe('github service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-token';
    resetEnvCache();
    _clearConditionalGetCaches();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('githubFetchResponse', () => {
    it('should fetch from the GitHub API with the token', async () => {
      const mockData = { id: 1, name: 'test' };
      mockFetch.mockResolvedValue(createMockResponse(mockData));

      const result = await githubFetchResponse('/repos/owner/repo', 'token');
      expect(await result.json()).toEqual(mockData);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/owner/repo',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token',
          }),
        })
      );
    });

    it('should throw GitHubApiError on non-ok response', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 404));

      await expect(githubFetchResponse('/repos/owner/repo', 'token')).rejects.toThrow(
        GitHubApiError
      );
    });

    it("should carry GitHub's error message on the thrown error", async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({ message: 'Resource not accessible by personal access token' }, 403)
      );

      await expect(
        githubFetchResponse('/repos/owner/repo/branches', 'token')
      ).rejects.toMatchObject({
        status: 403,
        apiMessage: 'Resource not accessible by personal access token',
      });
    });

    it('should tolerate a non-JSON error body', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        json: vi.fn().mockRejectedValue(new Error('not json')),
        headers: { get: () => null },
      });

      await expect(githubFetchResponse('/repos/owner/repo', 'token')).rejects.toMatchObject({
        status: 502,
        apiMessage: undefined,
      });
    });

    it('treats a 304 nobody asked for as an error', async () => {
      mockFetch.mockResolvedValue(createMockResponse(null, 304));
      await expect(githubFetchResponse('/repos/owner/repo', 'token')).rejects.toThrow(
        GitHubApiError
      );
    });
  });

  describe('ConditionalGetCache', () => {
    const sentHeaders = (call: number): Record<string, string> =>
      mockFetch.mock.calls[call][1].headers;
    const parseName = async (response: Response) =>
      ((await response.json()) as { name: string }).name;

    it('does not remember a response without an ETag', async () => {
      const cache = new ConditionalGetCache<string>(10);
      mockFetch.mockResolvedValueOnce(createMockResponse({ name: 'a' }, 200, '"v1"'));
      await cache.fetch('/x', 'token', parseName);

      mockFetch.mockResolvedValueOnce(createMockResponse({ name: 'b' }));
      expect(await cache.fetch('/x', 'token', parseName)).toBe('b');

      mockFetch.mockResolvedValueOnce(createMockResponse({ name: 'c' }));
      await cache.fetch('/x', 'token', parseName);
      expect(sentHeaders(2)['If-None-Match']).toBeUndefined();
    });

    it('evicts the least recently used path past its capacity', async () => {
      const cache = new ConditionalGetCache<string>(2);
      for (const path of ['/a', '/b']) {
        mockFetch.mockResolvedValueOnce(createMockResponse({ name: path }, 200, `"${path}"`));
        await cache.fetch(path, 'token', parseName);
      }
      mockFetch.mockResolvedValueOnce(createMockResponse(null, 304));
      await cache.fetch('/a', 'token', parseName);
      mockFetch.mockResolvedValueOnce(createMockResponse({ name: '/c' }, 200, '"/c"'));
      await cache.fetch('/c', 'token', parseName);

      mockFetch.mockResolvedValue(createMockResponse({ name: 'fresh' }));
      await cache.fetch('/a', 'token', parseName);
      await cache.fetch('/b', 'token', parseName);
      expect(sentHeaders(4)['If-None-Match']).toBe('"/a"');
      expect(sentHeaders(5)['If-None-Match']).toBeUndefined();
    });
  });

  describe('parseLinkHeader', () => {
    it('should parse next and last pages from link header', () => {
      const header =
        '<https://api.github.com/repos?page=3>; rel="next", <https://api.github.com/repos?page=5>; rel="last"';
      expect(parseLinkHeader(header)).toEqual({ next: '3', last: '5' });
    });

    it('should return empty object for null header', () => {
      expect(parseLinkHeader(null)).toEqual({});
    });

    it('should return empty object when no next link', () => {
      const header = '<https://api.github.com/repos?page=1>; rel="prev"';
      expect(parseLinkHeader(header)).toEqual({});
    });
  });

  describe('fetchPullRequestForBranch', () => {
    const openPull = {
      id: 1,
      number: 42,
      title: 'Add feature X',
      state: 'open',
      draft: false,
      merged_at: null,
      html_url: 'https://github.com/owner/repo/pull/42',
      head: { ref: 'feature', sha: 'abc' },
      base: { ref: 'main', repo: { default_branch: 'main' } },
      user: { login: 'author' },
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    };
    const sentHeaders = (call: number): Record<string, string> =>
      mockFetch.mock.calls[call][1].headers;

    it('revalidates with the last ETag and replays the cached answer on a 304', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([openPull], 200, '"v1"'));
      const first = await fetchPullRequestForBranch('owner/repo', 'feature');
      expect(sentHeaders(0)['If-None-Match']).toBeUndefined();

      mockFetch.mockResolvedValueOnce(createMockResponse(null, 304));
      const second = await fetchPullRequestForBranch('owner/repo', 'feature');

      expect(sentHeaders(1)['If-None-Match']).toBe('"v1"');
      expect(second).toEqual(first);
      expect(second?.number).toBe(42);
    });

    it('reports the base branch only when it is not the default', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([openPull]));
      expect((await fetchPullRequestForBranch('owner/repo', 'feature'))?.stackedOn).toBeNull();

      const stacked = { ...openPull, base: { ref: 'feature-a', repo: { default_branch: 'main' } } };
      mockFetch.mockResolvedValueOnce(createMockResponse([stacked]));
      expect((await fetchPullRequestForBranch('owner/repo', 'other'))?.stackedOn).toBe('feature-a');
    });

    it('replaces the cached answer when the PR changed', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([openPull], 200, '"v1"'));
      await fetchPullRequestForBranch('owner/repo', 'feature');

      const merged = { ...openPull, state: 'closed', merged_at: '2024-01-03T00:00:00Z' };
      mockFetch.mockResolvedValueOnce(createMockResponse([merged], 200, '"v2"'));
      expect((await fetchPullRequestForBranch('owner/repo', 'feature'))?.state).toBe('merged');

      mockFetch.mockResolvedValueOnce(createMockResponse(null, 304));
      expect((await fetchPullRequestForBranch('owner/repo', 'feature'))?.state).toBe('merged');
      expect(sentHeaders(2)['If-None-Match']).toBe('"v2"');
    });

    it('caches "no PR" too, and keys the cache by branch', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([], 200, '"empty"'));
      expect(await fetchPullRequestForBranch('owner/repo', 'a')).toBeNull();

      mockFetch.mockResolvedValueOnce(createMockResponse([openPull], 200, '"b1"'));
      await fetchPullRequestForBranch('owner/repo', 'b');
      expect(sentHeaders(1)['If-None-Match']).toBeUndefined();

      mockFetch.mockResolvedValueOnce(createMockResponse(null, 304));
      expect(await fetchPullRequestForBranch('owner/repo', 'a')).toBeNull();
      expect(sentHeaders(2)['If-None-Match']).toBe('"empty"');
    });

    it('should return PR info when a PR exists', async () => {
      const mockPulls = [
        {
          id: 1,
          number: 42,
          title: 'Add feature X',
          state: 'open',
          draft: false,
          merged_at: null,
          html_url: 'https://github.com/owner/repo/pull/42',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main', repo: { default_branch: 'main' } },
          user: { login: 'author' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      mockFetch.mockResolvedValue(createMockResponse(mockPulls));

      const result = await fetchPullRequestForBranch('owner/repo', 'feature-branch');

      expect(result).toEqual({
        number: 42,
        title: 'Add feature X',
        state: 'open',
        draft: false,
        url: 'https://github.com/owner/repo/pull/42',
        author: 'author',
        updatedAt: '2024-01-02T00:00:00Z',
        headBranch: 'feature',
        headSha: 'abc',
        stackedOn: null,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/repos/owner/repo/pulls?head='),
        expect.any(Object)
      );
    });

    it('should return null when no PR exists for branch', async () => {
      mockFetch.mockResolvedValue(createMockResponse([]));

      const result = await fetchPullRequestForBranch('owner/repo', 'no-pr-branch');

      expect(result).toBeNull();
    });

    it('should derive merged state from merged_at field', async () => {
      const mockPulls = [
        {
          id: 1,
          number: 10,
          title: 'Merged PR',
          state: 'closed',
          draft: false,
          merged_at: '2024-01-03T00:00:00Z',
          html_url: 'https://github.com/owner/repo/pull/10',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main', repo: { default_branch: 'main' } },
          user: { login: 'author' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-03T00:00:00Z',
        },
      ];
      mockFetch.mockResolvedValue(createMockResponse(mockPulls));

      const result = await fetchPullRequestForBranch('owner/repo', 'merged-branch');

      expect(result?.state).toBe('merged');
    });

    it('should handle draft PRs', async () => {
      const mockPulls = [
        {
          id: 1,
          number: 5,
          title: 'WIP: Draft PR',
          state: 'open',
          draft: true,
          merged_at: null,
          html_url: 'https://github.com/owner/repo/pull/5',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main', repo: { default_branch: 'main' } },
          user: { login: 'author' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      mockFetch.mockResolvedValue(createMockResponse(mockPulls));

      const result = await fetchPullRequestForBranch('owner/repo', 'draft-branch');

      expect(result?.draft).toBe(true);
      expect(result?.state).toBe('open');
    });

    it('should return undefined when no GitHub token is configured', async () => {
      delete process.env.GITHUB_TOKEN;
      resetEnvCache();

      const result = await fetchPullRequestForBranch('owner/repo', 'branch');

      expect(result).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return undefined when GitHub sends an unexpected shape', async () => {
      mockFetch.mockResolvedValue(createMockResponse([{ number: 'not a PR' }]));

      expect(await fetchPullRequestForBranch('owner/repo', 'branch')).toBeUndefined();
    });

    it('should return undefined on API errors', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 500));

      const result = await fetchPullRequestForBranch('owner/repo', 'branch');

      expect(result).toBeUndefined();
    });

    it('should handle PR with null user', async () => {
      const mockPulls = [
        {
          id: 1,
          number: 7,
          title: 'Ghost user PR',
          state: 'open',
          draft: false,
          merged_at: null,
          html_url: 'https://github.com/owner/repo/pull/7',
          head: { ref: 'feature', sha: 'abc' },
          base: { ref: 'main', repo: { default_branch: 'main' } },
          user: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];
      mockFetch.mockResolvedValue(createMockResponse(mockPulls));

      const result = await fetchPullRequestForBranch('owner/repo', 'ghost-branch');

      expect(result?.author).toBe('unknown');
    });

    it('should use correct head filter format', async () => {
      mockFetch.mockResolvedValue(createMockResponse([]));

      await fetchPullRequestForBranch('myorg/myrepo', 'feature/test');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('head=' + encodeURIComponent('myorg:feature/test')),
        expect.any(Object)
      );
    });
  });
  describe('watched-repo lookups', () => {
    const pull = (number: number) => ({
      number,
      title: `PR ${number}`,
      state: 'open',
      draft: false,
      merged_at: null,
      html_url: `https://github.com/owner/repo/pull/${number}`,
      head: { ref: `branch-${number}`, sha: `sha-${number}` },
      base: { ref: 'main', repo: { default_branch: 'main' } },
      user: { login: 'author' },
      updated_at: '2024-01-02T00:00:00Z',
    });

    it('lists every open PR in a repo', async () => {
      mockFetch.mockResolvedValue(createMockResponse([pull(1), pull(2)]));

      const prs = await fetchOpenPullRequests('owner/repo');

      expect(prs.map((pr) => [pr.number, pr.headBranch, pr.headSha])).toEqual([
        [1, 'branch-1', 'sha-1'],
        [2, 'branch-2', 'sha-2'],
      ]);
      expect(mockFetch.mock.calls[0][0]).toContain('/repos/owner/repo/pulls?state=open');
    });

    it('throws when the open list or a single PR can’t be read, so the caller can tell', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 404));
      await expect(fetchOpenPullRequests('owner/repo')).rejects.toThrow(GitHubApiError);
      await expect(fetchPullRequest('owner/repo', 3)).rejects.toThrow(GitHubApiError);
    });

    it('fetches one PR by number', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({ ...pull(3), state: 'closed', merged_at: '2024-01-03T00:00:00Z' })
      );

      expect((await fetchPullRequest('owner/repo', 3)).state).toBe('merged');
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.github.com/repos/owner/repo/pulls/3');
    });

    it('rolls a commit’s check runs and statuses up together', async () => {
      mockFetch.mockImplementation(async (url: string) =>
        url.includes('/check-runs')
          ? createMockResponse({ check_runs: [{ status: 'completed', conclusion: 'success' }] })
          : createMockResponse({ statuses: [{ state: 'pending' }] })
      );

      expect(await fetchChecks('owner/repo', 'abc')).toBe('pending');
    });

    it('reads checks the token can’t see as unknown, but throws on a transient failure', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 403));
      expect(await fetchChecks('owner/repo', 'abc')).toBeNull();

      mockFetch.mockResolvedValue(createMockResponse({}, 502));
      await expect(fetchChecks('owner/repo', 'abc')).rejects.toThrow(GitHubApiError);

      mockFetch.mockResolvedValue(
        createMockResponse({ message: 'API rate limit exceeded for user ID 1.' }, 403)
      );
      await expect(fetchChecks('owner/repo', 'abc')).rejects.toThrow(GitHubApiError);

      mockFetch.mockResolvedValue({
        ...createMockResponse({ message: 'Forbidden' }, 403),
        headers: { get: (name: string) => (name === 'x-ratelimit-remaining' ? '0' : null) },
      });
      await expect(fetchChecks('owner/repo', 'abc')).rejects.toThrow(GitHubApiError);

      delete process.env.GITHUB_TOKEN;
      resetEnvCache();
      mockFetch.mockClear();
      expect(await fetchChecks('owner/repo', 'abc')).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('fetchRecentComments', () => {
    const base = {
      body: 'Looks good',
      author_association: 'OWNER',
      created_at: '2024-01-01T00:00:00Z',
    };
    const person = { login: 'brendan', type: 'User' };
    const bot = { login: 'dependabot[bot]', type: 'Bot' };

    it('returns conversation and review comments by people, tied to their PR numbers', async () => {
      mockFetch.mockImplementation(async (url: string) =>
        url.includes('/issues/comments')
          ? createMockResponse([
              {
                ...base,
                id: 1,
                html_url: 'https://github.com/o/r/pull/12#issuecomment-1',
                user: person,
                issue_url: 'https://api.github.com/repos/o/r/issues/12',
              },
              {
                ...base,
                id: 2,
                html_url: 'https://github.com/o/r/pull/12#issuecomment-2',
                user: bot,
                issue_url: 'https://api.github.com/repos/o/r/issues/12',
              },
            ])
          : createMockResponse([
              {
                ...base,
                id: 1,
                html_url: 'https://github.com/o/r/pull/7#discussion_r1',
                user: person,
                pull_request_url: 'https://api.github.com/repos/o/r/pulls/7',
                path: 'src/a.ts',
              },
            ])
      );

      const comments = await fetchRecentComments('o/r');

      expect(comments.map((c) => [c.number, c.author, c.path])).toEqual([
        [12, 'brendan', null],
        [7, 'brendan', 'src/a.ts'],
      ]);
      expect(new Set(comments.map((c) => c.key)).size).toBe(2);
    });

    it('throws when the comments can’t be read', async () => {
      mockFetch.mockResolvedValue(createMockResponse({ message: 'Not Found' }, 404));
      await expect(fetchRecentComments('o/r')).rejects.toThrow(GitHubApiError);
    });
  });

  describe('security alerts', () => {
    function secretAlert(number: number, state = 'open') {
      return {
        number,
        state,
        html_url: `https://github.com/o/r/security/secret-scanning/${number}`,
        created_at: '2026-01-01T00:00:00Z',
        secret_type: 'npm_token',
        secret: 'npm_shh',
      };
    }

    function pageResponse(items: unknown[], link: string | null) {
      return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(items),
        headers: { get: (name: string) => (name.toLowerCase() === 'link' ? link : null) },
      };
    }

    it('follows cursor links through every page of open alerts', async () => {
      mockFetch
        .mockResolvedValueOnce(
          pageResponse(
            [secretAlert(1)],
            '<https://api.github.com/repositories/9/secret-scanning/alerts?state=open&per_page=100&after=abc>; rel="next"'
          )
        )
        .mockResolvedValueOnce(pageResponse([secretAlert(2)], null));

      const alerts = await fetchOpenSecurityAlerts('o/r', 'secret-scanning');

      expect(alerts.map((a) => a.number)).toEqual([1, 2]);
      expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
        'https://api.github.com/repos/o/r/secret-scanning/alerts?state=open&per_page=100&hide_secret=true',
        'https://api.github.com/repositories/9/secret-scanning/alerts?state=open&per_page=100&after=abc',
      ]);
    });

    it('reads one alert, and null for one that no longer exists', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(secretAlert(3, 'resolved')));
      expect((await fetchSecurityAlert('o/r', 'secret-scanning', 3))?.closure?.state).toBe(
        'resolved'
      );

      mockFetch.mockResolvedValueOnce(createMockResponse({ message: 'Not Found' }, 404));
      expect(await fetchSecurityAlert('o/r', 'secret-scanning', 4)).toBeNull();
    });

    it('throws when a kind of alert can’t be read', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse({ message: 'Dependabot alerts are disabled for this repository.' }, 403)
      );
      await expect(fetchOpenSecurityAlerts('o/r', 'dependabot')).rejects.toThrow(/disabled/);
    });
  });
});
