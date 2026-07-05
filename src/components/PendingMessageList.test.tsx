import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PendingMessageList } from './PendingMessageList';
import type { PendingMessage } from '@/lib/pending-message';

const msg = (id: string, text: string, attachments: PendingMessage['attachments'] = []) => ({
  id,
  text,
  attachments,
});

describe('PendingMessageList', () => {
  it('renders nothing when there are no pending messages', () => {
    const { container } = render(<PendingMessageList messages={[]} onCancel={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders each pending message in order with a Queued marker', () => {
    render(
      <PendingMessageList messages={[msg('1', 'alpha'), msg('2', 'beta')]} onCancel={vi.fn()} />
    );

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
    expect(screen.getAllByText('Queued')).toHaveLength(2);
  });

  it('shows attachment names as chips', () => {
    render(
      <PendingMessageList
        messages={[
          msg('1', 'see file', [{ name: 'notes.md', storedName: 'x-notes.md', path: '/x' }]),
        ]}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText('notes.md')).toBeInTheDocument();
  });

  it('calls onCancel with the message id when Remove is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<PendingMessageList messages={[msg('abc', 'drop me')]} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: /remove queued message/i }));

    expect(onCancel).toHaveBeenCalledWith('abc');
  });
});
