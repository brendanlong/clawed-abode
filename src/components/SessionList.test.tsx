import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionList } from './SessionList';
import type { Session } from '@/hooks/useSessionList';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Mock trpc so SessionListItem's useMutation and useQuery calls work without a provider
vi.mock('@/lib/trpc', () => ({
  trpc: {
    sessions: {
      start: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      stop: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      delete: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
    github: {
      getSessionPrStatus: {
        useQuery: () => ({ data: null, isLoading: false }),
      },
    },
  },
}));

describe('SessionList', () => {
  describe('loading state', () => {
    it('shows spinner while loading', () => {
      render(
        <SessionList
          sessions={[]}
          isLoading={true}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const spinner = document.querySelector('[class*="animate-spin"]');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows empty state message when no sessions', () => {
      render(
        <SessionList
          sessions={[]}
          isLoading={false}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      expect(screen.getByText('No sessions yet')).toBeInTheDocument();
      expect(screen.getByText('Get started by creating a new session.')).toBeInTheDocument();
    });

    it('shows "New Session" link in empty state', () => {
      render(
        <SessionList
          sessions={[]}
          isLoading={false}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const newSessionLink = screen.getByRole('link', { name: /new session/i });
      expect(newSessionLink).toBeInTheDocument();
      expect(newSessionLink).toHaveAttribute('href', '/new');
    });
  });

  describe('sessions list', () => {
    const mockSessions: Session[] = [
      {
        id: 'session-1',
        name: 'Test Session 1',
        repoUrl: 'https://github.com/user/repo1.git',
        branch: 'main',
        status: 'running',
        turnActive: true,
        backgroundActive: false,
        lastActivityAt: new Date('2024-01-15T10:00:00Z'),
      },
      {
        id: 'session-2',
        name: 'Test Session 2',
        repoUrl: 'https://github.com/user/repo2.git',
        branch: 'feature-branch',
        status: 'stopped',
        turnActive: false,
        backgroundActive: false,
        lastActivityAt: new Date('2024-01-14T09:00:00Z'),
      },
      {
        id: 'session-3',
        name: 'Test Session 3',
        repoUrl: 'https://github.com/user/repo3.git',
        branch: 'main',
        status: 'running',
        turnActive: false,
        backgroundActive: false,
        lastActivityAt: new Date('2024-01-13T08:00:00Z'),
      },
    ];

    it('renders list of sessions', () => {
      render(
        <SessionList
          sessions={mockSessions}
          isLoading={false}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      expect(screen.getByText('Test Session 1')).toBeInTheDocument();
      expect(screen.getByText('Test Session 2')).toBeInTheDocument();
    });

    it('links to individual session pages', () => {
      render(
        <SessionList
          sessions={mockSessions}
          isLoading={false}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const sessionLinks = screen.getAllByRole('link');
      const session1Link = sessionLinks.find((link) =>
        link.getAttribute('href')?.includes('session-1')
      );
      expect(session1Link).toHaveAttribute('href', '/session/session-1');
    });

    it('renders sessions in order', () => {
      render(
        <SessionList
          sessions={mockSessions}
          isLoading={false}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const sessionNames = screen.getAllByRole('listitem');
      expect(sessionNames).toHaveLength(3);
    });

    it('shows running/waiting/stopped based on status and turn state', () => {
      render(
        <SessionList
          sessions={mockSessions}
          isLoading={false}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const items = screen.getAllByRole('listitem');
      // Session 1: status running with an active turn → "running"
      expect(items[0]).toHaveTextContent('running');
      // Session 2: status stopped → "stopped"
      expect(items[1]).toHaveTextContent('stopped');
      // Session 3: status running but idle → "waiting"
      expect(items[2]).toHaveTextContent('waiting');
    });

    it('shows "background" when the main agent is idle but a subagent runs', () => {
      const backgroundSession: Session = {
        id: 'session-bg',
        name: 'Background Session',
        repoUrl: 'https://github.com/user/repo-bg.git',
        branch: 'main',
        status: 'running',
        turnActive: false,
        backgroundActive: true,
        lastActivityAt: new Date('2024-01-12T08:00:00Z'),
      };
      render(
        <SessionList
          sessions={[backgroundSession]}
          isLoading={false}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const [item] = screen.getAllByRole('listitem');
      expect(item).toHaveTextContent('background');
    });
  });
});
