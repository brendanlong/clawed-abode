import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssueSelector } from './IssueSelector';

type Page = { issues: Array<{ id: number; number: number; title: string; labels: [] }> };
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
});
