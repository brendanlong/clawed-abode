import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RepoSelector, type Repo } from './RepoSelector';

type QueryResult = {
  data?: { repos: Repo[]; truncated: boolean };
  isLoading: boolean;
  error?: { message: string };
};

const listReposResult = vi.hoisted(() => ({ current: null as QueryResult | null }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    github: {
      listRepos: { useQuery: () => listReposResult.current },
    },
    repoSettings: {
      listFavorites: { useQuery: () => ({ data: { favorites: [] } }) },
      toggleFavorite: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    useUtils: () => ({ repoSettings: { listFavorites: { invalidate: vi.fn() } } }),
  },
}));

function baseResult(overrides: Partial<QueryResult>): QueryResult {
  return { isLoading: false, ...overrides };
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
      data: { repos: [], truncated: false },
    });

    render(<RepoSelector selectedRepo={null} onSelect={vi.fn()} />);

    expect(screen.queryByText(/Could not load repositories/)).not.toBeInTheDocument();
  });

  it('finds org repos and forks by partial name', async () => {
    const user = userEvent.setup();
    const repo = (id: number, fullName: string): Repo => ({
      id,
      fullName,
      name: fullName.split('/')[1],
      owner: fullName.split('/')[0],
      description: null,
      private: false,
      defaultBranch: 'main',
    });
    listReposResult.current = baseResult({
      data: {
        repos: [
          repo(1, 'brendanlong/wiki'),
          repo(2, 'brendanlong/bergson'),
          repo(3, 'EleutherAI/bergson'),
        ],
        truncated: false,
      },
    });

    render(<RepoSelector selectedRepo={null} onSelect={vi.fn()} />);
    await user.type(screen.getByPlaceholderText(/Search your repositories/), 'ber');

    expect(screen.getByText('brendanlong/bergson')).toBeInTheDocument();
    expect(screen.getByText('EleutherAI/bergson')).toBeInTheDocument();
    expect(screen.queryByText('brendanlong/wiki')).not.toBeInTheDocument();
  });
});
