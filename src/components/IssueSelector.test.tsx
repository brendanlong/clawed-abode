import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IssueSelector } from './IssueSelector';
import type { Issue } from '@/lib/types';

type Page = { issues: Issue[] };
type QueryResult = {
  data?: { pages: Page[] };
  isLoading: boolean;
  error?: { message: string };
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

const listIssuesResult = vi.hoisted(() => ({ current: null as QueryResult | null }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    github: {
      listIssues: { useInfiniteQuery: () => listIssuesResult.current },
    },
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

describe('IssueSelector', () => {
  beforeEach(() => {
    listIssuesResult.current = null;
  });

  it('shows the failure reason instead of claiming there are no issues', () => {
    listIssuesResult.current = baseResult({
      error: { message: 'Resource not accessible by personal access token' },
    });

    render(<IssueSelector repoFullName="owner/repo" selectedIssue={null} onSelect={vi.fn()} />);

    expect(
      screen.getByText(/Resource not accessible by personal access token/)
    ).toBeInTheDocument();
    expect(screen.queryByText('No open issues')).not.toBeInTheDocument();
  });

  it('reports no open issues when the query succeeded and returned none', () => {
    listIssuesResult.current = baseResult({ data: { pages: [{ issues: [] }] } });

    render(<IssueSelector repoFullName="owner/repo" selectedIssue={null} onSelect={vi.fn()} />);

    expect(screen.getByText('No open issues')).toBeInTheDocument();
  });

  it('selects and clears an issue from the keyboard', async () => {
    const user = userEvent.setup();
    const issue: Issue = {
      id: 7,
      number: 42,
      title: 'Fix the thing',
      body: null,
      labels: [],
      comments: 0,
    };
    listIssuesResult.current = baseResult({ data: { pages: [{ issues: [issue] }] } });
    const onSelect = vi.fn();

    const { rerender } = render(
      <IssueSelector repoFullName="owner/repo" selectedIssue={null} onSelect={onSelect} />
    );
    screen.getByRole('button', { name: /Fix the thing/ }).focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(issue);

    rerender(<IssueSelector repoFullName="owner/repo" selectedIssue={issue} onSelect={onSelect} />);
    expect(screen.getByRole('button', { name: /Fix the thing/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    screen.getByRole('button', { name: 'Clear selection' }).focus();
    await user.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });
});
