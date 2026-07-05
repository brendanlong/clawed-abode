import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditableSessionName } from './EditableSessionName';

describe('EditableSessionName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the name as a heading by default', () => {
    render(<EditableSessionName name="My Session" onRename={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'My Session' })).toBeInTheDocument();
  });

  it('switches to an input when the name is clicked', async () => {
    const user = userEvent.setup();
    render(<EditableSessionName name="My Session" onRename={vi.fn()} />);

    await user.click(screen.getByRole('heading', { name: 'My Session' }));

    const input = screen.getByRole('textbox', { name: 'Session name' });
    expect(input).toHaveValue('My Session');
  });

  it('calls onRename with the trimmed new name on Enter', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<EditableSessionName name="Old" onRename={onRename} />);

    await user.click(screen.getByRole('heading', { name: 'Old' }));
    const input = screen.getByRole('textbox', { name: 'Session name' });
    await user.clear(input);
    await user.type(input, '  New Name  {Enter}');

    expect(onRename).toHaveBeenCalledExactlyOnceWith('New Name');
    // Exits edit mode; the displayed name is controlled by the parent via the
    // `name` prop, so it still reads "Old" until the parent updates it.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Old' })).toBeInTheDocument();
  });

  it('does not call onRename when the name is unchanged', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<EditableSessionName name="Same" onRename={onRename} />);

    await user.click(screen.getByRole('heading', { name: 'Same' }));
    await user.type(screen.getByRole('textbox', { name: 'Session name' }), '{Enter}');

    expect(onRename).not.toHaveBeenCalled();
  });

  it('does not call onRename when the name is emptied', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<EditableSessionName name="Something" onRename={onRename} />);

    await user.click(screen.getByRole('heading', { name: 'Something' }));
    const input = screen.getByRole('textbox', { name: 'Session name' });
    await user.clear(input);
    await user.type(input, '{Enter}');

    expect(onRename).not.toHaveBeenCalled();
  });

  it('cancels editing on Escape without calling onRename', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<EditableSessionName name="Original" onRename={onRename} />);

    await user.click(screen.getByRole('heading', { name: 'Original' }));
    const input = screen.getByRole('textbox', { name: 'Session name' });
    await user.clear(input);
    await user.type(input, 'Discarded{Escape}');

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Original' })).toBeInTheDocument();
  });

  it('does not enter edit mode when disabled', async () => {
    const user = userEvent.setup();
    render(<EditableSessionName name="Locked" onRename={vi.fn()} disabled />);

    await user.click(screen.getByRole('heading', { name: 'Locked' }));

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
