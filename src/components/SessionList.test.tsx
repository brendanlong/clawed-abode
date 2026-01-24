import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

// Mock the trpc module
vi.mock('@/lib/trpc', () => ({
  trpc: {
    sessions: {
      list: {
        useQuery: vi.fn(),
      },
      start: {
        useMutation: vi.fn(() => ({
          mutate: vi.fn(),
          isPending: false,
        })),
      },
      stop: {
        useMutation: vi.fn(() => ({
          mutate: vi.fn(),
          isPending: false,
        })),
      },
      delete: {
        useMutation: vi.fn(() => ({
          mutate: vi.fn(),
          isPending: false,
        })),
      },
    },
  },
}));

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Import component after mocks are set up
import { SessionList } from './SessionList';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('SessionList', () => {
  const mockUseQuery = vi.mocked(trpc.sessions.list.useQuery);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loading state', () => {
    it('shows spinner while loading', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: true,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      // Check for spinner (via role or class)
      const spinner = document.querySelector('[class*="animate-spin"]');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows empty state message when no sessions', () => {
      mockUseQuery.mockReturnValue({
        data: { sessions: [] },
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      expect(screen.getByText('No sessions yet')).toBeInTheDocument();
      expect(screen.getByText('Get started by creating a new session.')).toBeInTheDocument();
    });

    it('shows "New Session" link in empty state', () => {
      mockUseQuery.mockReturnValue({
        data: { sessions: [] },
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      const newSessionLink = screen.getByRole('link', { name: /new session/i });
      expect(newSessionLink).toBeInTheDocument();
      expect(newSessionLink).toHaveAttribute('href', '/new');
    });
  });

  describe('sessions list', () => {
    const mockSessions = [
      {
        id: 'session-1',
        name: 'Test Session 1',
        repoUrl: 'https://github.com/user/repo1.git',
        branch: 'main',
        status: 'running',
        updatedAt: new Date('2024-01-15T10:00:00Z'),
      },
      {
        id: 'session-2',
        name: 'Test Session 2',
        repoUrl: 'https://github.com/user/repo2.git',
        branch: 'feature-branch',
        status: 'stopped',
        updatedAt: new Date('2024-01-14T09:00:00Z'),
      },
    ];

    it('renders list of sessions', () => {
      mockUseQuery.mockReturnValue({
        data: { sessions: mockSessions },
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      expect(screen.getByText('Test Session 1')).toBeInTheDocument();
      expect(screen.getByText('Test Session 2')).toBeInTheDocument();
    });

    it('links to individual session pages', () => {
      mockUseQuery.mockReturnValue({
        data: { sessions: mockSessions },
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      const sessionLinks = screen.getAllByRole('link');
      const session1Link = sessionLinks.find((link) =>
        link.getAttribute('href')?.includes('session-1')
      );
      expect(session1Link).toHaveAttribute('href', '/session/session-1');
    });

    it('renders sessions in order', () => {
      mockUseQuery.mockReturnValue({
        data: { sessions: mockSessions },
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      const sessionNames = screen.getAllByRole('listitem');
      expect(sessionNames).toHaveLength(2);
    });
  });

  describe('data handling', () => {
    it('handles undefined data gracefully', () => {
      mockUseQuery.mockReturnValue({
        data: undefined,
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      // Should show empty state when data is undefined
      expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    });

    it('handles null sessions array gracefully', () => {
      mockUseQuery.mockReturnValue({
        data: { sessions: null },
        isLoading: false,
        refetch: vi.fn(),
      } as unknown as ReturnType<typeof trpc.sessions.list.useQuery>);

      render(<SessionList />, { wrapper: createWrapper() });

      // Should show empty state
      expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    });
  });
});
