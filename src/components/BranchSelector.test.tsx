import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BRANCH_PICKER_LIMIT, BranchSelector } from './BranchSelector';

type QueryResult = {
  data?: { branches: string[]; defaultBranch: string; truncated: boolean };
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
      data: { branches: [], defaultBranch: 'main', truncated: false },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="" onSelect={vi.fn()} />);

    expect(screen.getByText(/repository may be empty/)).toBeInTheDocument();
  });

  it('keeps the branch list usable when a refetch fails', () => {
    listBranchesResult.current = {
      isLoading: false,
      error: { message: 'GitHub rate limit exceeded' },
      data: { branches: ['main'], defaultBranch: 'main', truncated: false },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="main" onSelect={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Branch' })).toBeInTheDocument();
    expect(screen.queryByText(/Could not load branches/)).not.toBeInTheDocument();
  });

  it('auto-selects the default branch once branches load', () => {
    const onSelect = vi.fn();
    listBranchesResult.current = {
      isLoading: false,
      data: {
        branches: ['main', 'dev'],
        defaultBranch: 'main',
        truncated: false,
      },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="" onSelect={onSelect} />);

    expect(onSelect).toHaveBeenCalledWith('main');
  });

  it('filters branches by search text', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    listBranchesResult.current = {
      isLoading: false,
      data: { branches: ['main', 'fix/a', 'feature/b'], defaultBranch: 'main', truncated: false },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="main" onSelect={onSelect} />);

    await user.click(screen.getByRole('combobox', { name: 'Branch' }));
    await user.type(screen.getByPlaceholderText('Search branches...'), 'feat');

    expect(screen.queryByRole('option', { name: /fix\/a/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /feature\/b/ }));
    expect(onSelect).toHaveBeenCalledWith('feature/b');
  });

  it('caps rendered branches but keeps the selected one', async () => {
    const user = userEvent.setup();
    const branches = Array.from({ length: 300 }, (_, i) => `b${i}`);
    listBranchesResult.current = {
      isLoading: false,
      data: { branches, defaultBranch: 'b0', truncated: false },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="b299" onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Branch' }));

    expect(screen.getAllByRole('option')).toHaveLength(BRANCH_PICKER_LIMIT);
    expect(screen.getByRole('option', { name: 'b299' })).toBeInTheDocument();
    expect(screen.getByText(/Showing 100 of 300 branches/)).toBeInTheDocument();
  });

  it('warns when the server could not list every branch', async () => {
    const user = userEvent.setup();
    listBranchesResult.current = {
      isLoading: false,
      data: { branches: ['main'], defaultBranch: 'main', truncated: true },
    };

    render(<BranchSelector repoFullName="owner/repo" selectedBranch="main" onSelect={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: 'Branch' }));

    expect(screen.getByText(/too many branches/)).toBeInTheDocument();
  });
});
