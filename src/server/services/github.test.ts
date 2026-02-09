import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

import { fetchPullRequestForBranch, GitHubApiError, githubFetch, parseLinkHeader } from './github';

function createMockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    headers: {
      get: () => null,
    },
  };
}

describe('github service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-token';
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('githubFetch', () => {
    it('should fetch and parse JSON from GitHub API', async () => {
      const mockData = { id: 1, name: 'test' };
      mockFetch.mockResolvedValue(createMockResponse(mockData));

      const result = await githubFetch<{ id: number; name: string }>('/repos/owner/repo', 'token');
      expect(result).toEqual(mockData);
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

      await expect(githubFetch('/repos/owner/repo', 'token')).rejects.toThrow(GitHubApiError);
    });
  });

  describe('parseLinkHeader', () => {
    it('should parse next page from link header', () => {
      const header =
        '<https://api.github.com/repos?page=3>; rel="next", <https://api.github.com/repos?page=5>; rel="last"';
      expect(parseLinkHeader(header)).toEqual({ next: '3' });
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

      const result = await fetchPullRequestForBranch('owner/repo', 'branch');

      expect(result).toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
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
});
