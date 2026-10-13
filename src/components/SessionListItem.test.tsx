import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionListItem } from './SessionListItem';
import type { Session } from '@/hooks/useSessionList';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

interface MutationOptions {
  onMutate?: () => void;
  onError?: (err: { message: string }) => void;
}

// Every mutation fails, so the test sees what the user sees when the server rejects an action.
const { failingMutation } = vi.hoisted(() => ({
  failingMutation: (opts: MutationOptions = {}) => ({
    mutate: () => {
      opts.onMutate?.();
      opts.onError?.({ message: 'server said no' });
    },
    isPending: false,
  }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    sessions: {
      start: { useMutation: failingMutation },
      stop: { useMutation: failingMutation },
      delete: { useMutation: failingMutation },
    },
  },
}));

const SESSION: Session = {
  id: 's1',
  name: 'My Session',
  repoUrl: 'https://github.com/user/repo.git',
  branch: 'main',
  status: 'running',
  canStart: false,
  canStop: true,
  canArchive: true,
  statusMessage: null,
  currentBranch: null,
  pullRequest: null,
  turnActive: false,
  backgroundActive: false,
  rateLimitPaused: false,
  lastActivityAt: new Date('2024-01-15T10:00:00Z'),
  attentionAt: null,
  attentionSummary: null,
  createdAt: new Date('2024-01-15T09:00:00Z'),
};

describe('SessionListItem', () => {
  it('shows the error when stopping fails, and dismisses it', async () => {
    const user = userEvent.setup();
    render(<SessionListItem session={SESSION} />);

    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to stop session: server said no');

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the error when starting fails', async () => {
    const user = userEvent.setup();
    render(<SessionListItem session={{ ...SESSION, canStart: true, canStop: false }} />);

    await user.click(screen.getByRole('button', { name: /start/i }));
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to start session: server said no');
  });
});
