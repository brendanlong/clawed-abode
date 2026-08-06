import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BranchSelector } from './BranchSelector';

type QueryResult = {
  data?: { branches: Array<{ name: string; protected: boolean }>; defaultBranch: string };
  isLoading: boolean;
  error?: { message: string };
};

const listBranchesResult = vi.hoisted(() => ({ current: null as QueryResult | null }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    github: {
      listBranches: {
        useQuery: () => listBranchesResult.current,
      },
    },
  },
}));

describe('BranchSelector', () => {
  beforeEach(() => {
    listBranchesResult.current = null;
  });

  it('shows the failure reason when the branch query errors', () => {
    listBranchesResult.current = {
      isLoading: false,
      error: { message: 'Resource not accessible by personal access token' },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="" onSelect={vi.fn()} />);

    expect(
      screen.getByText(/Resource not accessible by personal access token/)
    ).toBeInTheDocument();
    // A permission failure must not be reported as an empty repository.
    expect(screen.queryByText(/repository may be empty/)).not.toBeInTheDocument();
  });

  it('reports an empty repository only when the query succeeded with no branches', () => {
    listBranchesResult.current = {
      isLoading: false,
      data: { branches: [], defaultBranch: 'main' },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="" onSelect={vi.fn()} />);

    expect(screen.getByText(/repository may be empty/)).toBeInTheDocument();
  });

  it('auto-selects the default branch once branches load', () => {
    const onSelect = vi.fn();
    listBranchesResult.current = {
      isLoading: false,
      data: {
        branches: [
          { name: 'main', protected: true },
          { name: 'dev', protected: false },
        ],
        defaultBranch: 'main',
      },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="" onSelect={onSelect} />);

    expect(onSelect).toHaveBeenCalledWith('main');
  });
});
