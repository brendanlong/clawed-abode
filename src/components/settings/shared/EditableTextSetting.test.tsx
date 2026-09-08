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

  it('cancelling leaves edit mode and resets the mutation error', async () => {
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

    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('boom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mutation.reset).toHaveBeenCalledTimes(1);
    expect(screen.queryByPlaceholderText('Type here')).not.toBeInTheDocument();
  });
});
