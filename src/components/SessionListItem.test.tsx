import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

// Stop and archive fail, start succeeds, so tests see what the user sees either way.
const { mutation } = vi.hoisted(() => ({
  mutation:
    (fails: boolean) =>
    (opts: MutationOptions = {}) => ({
      mutate: () => {
        opts.onMutate?.();
        if (fails) opts.onError?.({ message: 'server said no' });
      },
      isPending: false,
    }),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    sessions: {
      start: { useMutation: mutation(false) },
      stop: { useMutation: mutation(true) },
      delete: { useMutation: mutation(true) },
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

  it('shows the error when archiving fails', async () => {
    const user = userEvent.setup();
    render(<SessionListItem session={SESSION} />);

    await user.click(screen.getByRole('button', { name: /archive/i }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: /^archive$/i })
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Failed to archive session: server said no'
    );
  });

  it('clears the previous error when another action starts', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SessionListItem session={SESSION} />);

    await user.click(screen.getByRole('button', { name: /stop/i }));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(<SessionListItem session={{ ...SESSION, canStart: true, canStop: false }} />);
    await user.click(screen.getByRole('button', { name: /start/i }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
