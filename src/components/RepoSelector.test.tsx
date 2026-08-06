import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RepoSelector } from './RepoSelector';

type Page = { repos: Array<{ fullName: string }>; nextCursor?: string };
type QueryResult = {
  data?: { pages: Page[] };
  isLoading: boolean;
  error?: { message: string };
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

const listReposResult = vi.hoisted(() => ({ current: null as QueryResult | null }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    github: {
      listRepos: { useInfiniteQuery: () => listReposResult.current },
    },
    repoSettings: {
      listFavorites: { useQuery: () => ({ data: { favorites: [] } }) },
      toggleFavorite: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    useUtils: () => ({ repoSettings: { listFavorites: { invalidate: vi.fn() } } }),
  },
}));

function baseResult(overrides: Partial<QueryResult>): QueryResult {
  return {
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  };
}

describe('RepoSelector', () => {
  beforeEach(() => {
    listReposResult.current = null;
  });

  it('shows the failure reason when the repo query errors', () => {
    listReposResult.current = baseResult({
      error: { message: 'GitHub token is invalid or expired' },
    });

    render(<RepoSelector selectedRepo={null} onSelect={vi.fn()} />);

    expect(screen.getByText(/GitHub token is invalid or expired/)).toBeInTheDocument();
  });

  it('still offers the no-repo option when the repo query errors', () => {
    listReposResult.current = baseResult({ error: { message: 'GitHub rate limit exceeded' } });

    render(<RepoSelector selectedRepo={null} onSelect={vi.fn()} />);

    // The synthetic entry is a valid choice even when GitHub is unreachable, so
    // the error must not replace the list.
    expect(screen.getByText('No Repository (workspace only)')).toBeInTheDocument();
  });

  it('does not claim an error when the query succeeded', () => {
    listReposResult.current = baseResult({
      data: { pages: [{ repos: [] }] },
    });

    render(<RepoSelector selectedRepo={null} onSelect={vi.fn()} />);

    expect(screen.queryByText(/Could not load repositories/)).not.toBeInTheDocument();
  });
});
