import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditableTextSetting } from './EditableTextSetting';

function idleMutation() {
  return { isPending: false, error: null, reset: vi.fn() };
}

describe('EditableTextSetting', () => {
  it('shows the add button when nothing is saved and saves a trimmed draft', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditableTextSetting
        value={null}
        onSave={onSave}
        mutation={idleMutation()}
        placeholder="Type here"
        addLabel="Add Prompt"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add Prompt' }));
    await user.type(screen.getByPlaceholderText('Type here'), '  hello  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toBe('hello');
  });

  it('saves null when the draft is cleared', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EditableTextSetting
        value="existing"
        onSave={onSave}
        mutation={idleMutation()}
        placeholder="Type here"
        addLabel="Add"
        editLabel="Edit Prompt"
      />
    );

    expect(screen.getByText('existing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit Prompt' }));
    await user.clear(screen.getByPlaceholderText('Type here'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave.mock.calls[0][0]).toBeNull();
  });

  it('opens with emptyDraft and can reset the draft to the default', async () => {
    const user = userEvent.setup();
    render(
      <EditableTextSetting
        value={null}
        onSave={vi.fn()}
        mutation={idleMutation()}
        placeholder="Type here"
        addLabel="Create"
        emptyDraft="default text"
        resetTo={{ label: 'Custom', value: 'default text' }}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Create' }));
    const textarea = screen.getByPlaceholderText('Type here');
    expect(textarea).toHaveValue('default text');

    await user.clear(textarea);
    await user.type(textarea, 'changed');
    await user.click(screen.getByRole('button', { name: 'Reset to Default' }));
    expect(textarea).toHaveValue('default text');
  });

  it('closes the editor once onSave reports success', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn((_value: string | null, onSuccess: () => void) => onSuccess());
    render(
      <EditableTextSetting
        value={null}
        onSave={onSave}
        mutation={idleMutation()}
        placeholder="Type here"
        addLabel="Add"
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.type(screen.getByPlaceholderText('Type here'), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByPlaceholderText('Type here')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('resets a stale mutation error when the editor opens or is cancelled', async () => {
    const user = userEvent.setup();
    const mutation = { isPending: false, error: { message: 'boom' }, reset: vi.fn() };
    render(
      <EditableTextSetting
        value={null}
        onSave={vi.fn()}
        mutation={mutation}
        placeholder="Type here"
        addLabel="Add"
      />
    );

    expect(screen.queryByText('boom')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(mutation.reset).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mutation.reset).toHaveBeenCalledTimes(2);
    expect(screen.queryByPlaceholderText('Type here')).not.toBeInTheDocument();
  });
});
