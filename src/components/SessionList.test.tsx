import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionList } from './SessionList';
import type { PagedSessions, Session } from '@/hooks/useSessionList';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Mock trpc so SessionListItem's useMutation calls work without a provider
vi.mock('@/lib/trpc', () => ({
  trpc: {
    sessions: {
      start: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      stop: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

function session(overrides: Partial<Session> & Pick<Session, 'id' | 'name'>): Session {
  return {
    repoUrl: 'https://github.com/user/repo.git',
    branch: 'main',
    status: 'running',
    statusMessage: null,
    currentBranch: null,
    pullRequest: null,
    turnActive: false,
    backgroundActive: false,
    rateLimitPaused: false,
    lastActivityAt: new Date('2024-01-15T10:00:00Z'),
    createdAt: new Date('2024-01-15T09:00:00Z'),
    ...overrides,
  };
}

function paged(sessions: Session[], overrides: Partial<PagedSessions> = {}): PagedSessions {
  return {
    sessions,
    isLoading: false,
    hasMore: false,
    isFetchingMore: false,
    fetchMore: vi.fn(),
    ...overrides,
  };
}

const none = paged([]);

describe('SessionList', () => {
  it('shows spinner while the active list loads', () => {
    render(
      <SessionList
        active={paged([], { isLoading: true })}
        archived={none}
        showArchived={false}
        onToggleArchived={vi.fn()}
      />
    );
    expect(document.querySelector('[class*="animate-spin"]')).toBeInTheDocument();
  });

  it('shows the empty state with a New Session link when there are no sessions', () => {
    render(
      <SessionList active={none} archived={none} showArchived={false} onToggleArchived={vi.fn()} />
    );
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /new session/i })).toHaveAttribute('href', '/new');
  });

  describe('sessions list', () => {
    const sessions = [
      session({ id: 'session-1', name: 'Test Session 1', turnActive: true }),
      session({ id: 'session-2', name: 'Test Session 2', status: 'stopped', branch: 'feature' }),
      session({ id: 'session-3', name: 'Test Session 3' }),
    ];

    it('renders sessions in order and links to their pages', () => {
      render(
        <SessionList
          active={paged(sessions)}
          archived={none}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );
      const items = screen.getAllByRole('listitem');
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent('Test Session 1');
      expect(
        screen.getAllByRole('link').some((l) => l.getAttribute('href') === '/session/session-1')
      ).toBe(true);
    });

    it('shows running/waiting/stopped/background from status and the live axes', () => {
      render(
        <SessionList
          active={paged([...sessions, session({ id: 'bg', name: 'BG', backgroundActive: true })])}
          archived={none}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );
      const items = screen.getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('running');
      expect(items[1]).toHaveTextContent('stopped');
      expect(items[2]).toHaveTextContent('waiting');
      expect(items[3]).toHaveTextContent('background');
    });

    it('shows the persisted pull request status', () => {
      render(
        <SessionList
          active={paged([
            session({
              id: 'pr',
              name: 'With PR',
              pullRequest: {
                number: 12,
                title: 'Fix it',
                state: 'merged',
                draft: false,
                url: 'https://github.com/user/repo/pull/12',
                author: 'me',
                updatedAt: '2024-01-01T00:00:00Z',
              },
            }),
          ])}
          archived={none}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );
      expect(screen.getByLabelText(/merged/i)).toBeInTheDocument();
    });

    it('offers to load more only while another page exists', () => {
      const fetchMore = vi.fn();
      const { rerender } = render(
        <SessionList
          active={paged(sessions, { hasMore: true, fetchMore })}
          archived={none}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );
      screen.getByRole('button', { name: /load more/i }).click();
      expect(fetchMore).toHaveBeenCalledTimes(1);

      rerender(
        <SessionList
          active={paged(sessions)}
          archived={none}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });

  describe('archived section', () => {
    const active = paged([session({ id: 'a', name: 'Active' })]);

    it('renders the archived list separately when requested', () => {
      render(
        <SessionList
          active={active}
          archived={paged([session({ id: 'z', name: 'Old', status: 'archived' })])}
          showArchived
          onToggleArchived={vi.fn()}
        />
      );
      expect(screen.getByText('Archived Sessions')).toBeInTheDocument();
      expect(screen.getByText('Old')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /hide archived/i })).toBeInTheDocument();
    });

    it('says so when there are no archived sessions', () => {
      render(
        <SessionList active={active} archived={none} showArchived onToggleArchived={vi.fn()} />
      );
      expect(screen.getByText('No archived sessions')).toBeInTheDocument();
    });
  });
});
