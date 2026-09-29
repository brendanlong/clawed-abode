import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsListEditor, type SettingsScope } from './SettingsListEditor';

interface Item {
  id: string;
  name: string;
}

const ITEMS: Item[] = [
  { id: 'a', name: 'ALPHA' },
  { id: 'b', name: 'BETA' },
];

/** Seeds its state from `existingItem` on mount only, like the real forms. */
function SeededForm({
  existingItem,
  onClose,
  onSuccess,
}: {
  existingItem: Item | undefined;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name] = useState(existingItem?.name ?? '');
  return (
    <div>
      <p>{existingItem ? `Editing ${name}` : 'Adding'}</p>
      <button onClick={onClose}>Cancel</button>
      <button onClick={onSuccess}>Save</button>
    </div>
  );
}

function renderEditor({
  items = ITEMS,
  scope = 'repo',
  onDelete = vi.fn().mockResolvedValue(undefined),
  onUpdate = vi.fn(),
}: {
  items?: Item[];
  scope?: SettingsScope;
  onDelete?: (name: string) => Promise<unknown>;
  onUpdate?: () => void;
} = {}) {
  const editor = (list: Item[]) => (
    <SettingsListEditor
      title="Things"
      itemNoun="thing"
      scope={scope}
      items={list}
      onDelete={onDelete}
      onUpdate={onUpdate}
      renderItem={(item) => <span>{item.name}</span>}
      renderForm={(props) => <SeededForm {...props} />}
    />
  );
  const { rerender } = render(editor(items));
  return {
    user: userEvent.setup(),
    onDelete,
    onUpdate,
    setItems: (list: Item[]) => rerender(editor(list)),
  };
}

function editButtonFor(name: string) {
  const row = screen.getByText(name).closest('li');
  if (!row) throw new Error(`no row for ${name}`);
  return within(row).getByRole('button', { name: 'Edit' });
}

describe('SettingsListEditor', () => {
  it('switches the form to the newly chosen item when editing A then B', async () => {
    const { user } = renderEditor();

    await user.click(editButtonFor('ALPHA'));
    expect(screen.getByText('Editing ALPHA')).toBeInTheDocument();

    await user.click(editButtonFor('BETA'));
    expect(screen.getByText('Editing BETA')).toBeInTheDocument();
    expect(screen.queryByText('Editing ALPHA')).not.toBeInTheDocument();
  });

  it('switches from the add form to editing an item', async () => {
    const { user } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('Adding')).toBeInTheDocument();

    await user.click(editButtonFor('BETA'));
    expect(screen.getByText('Editing BETA')).toBeInTheDocument();
  });

  it('switches from editing an item to the add form', async () => {
    const { user } = renderEditor();

    await user.click(editButtonFor('ALPHA'));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByText('Adding')).toBeInTheDocument();
    expect(screen.queryByText(/Editing/)).not.toBeInTheDocument();
  });

  it('closes the form on cancel without notifying the parent', async () => {
    const { user, onUpdate } = renderEditor();

    await user.click(editButtonFor('ALPHA'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(/Editing/)).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('closes the form and notifies the parent on success', async () => {
    const { user, onUpdate } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Add' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByText('Adding')).not.toBeInTheDocument();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('hides the edit form, rather than turning it into an add form, when its item disappears', async () => {
    const { user, setItems } = renderEditor();

    await user.click(editButtonFor('ALPHA'));
    setItems([ITEMS[1]]); // e.g. deleted elsewhere, then refetched

    expect(screen.queryByText(/Editing/)).not.toBeInTheDocument();
    expect(screen.queryByText('Adding')).not.toBeInTheDocument();
  });

  it('names the global scope in the empty message', () => {
    renderEditor({ items: [], scope: 'global' });
    expect(screen.getByText('No global things configured.')).toBeInTheDocument();
  });

  it('names the global scope in the delete dialog', async () => {
    const { user } = renderEditor({ scope: 'global' });
    await user.click(screen.getByRole('button', { name: 'Delete ALPHA' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete thing?' })).toHaveTextContent(
      'This will delete the global thing ALPHA.'
    );
  });

  it('leaves the repo scope unqualified', () => {
    renderEditor({ items: [] });
    expect(screen.getByText('No things configured.')).toBeInTheDocument();
  });

  it('deletes the confirmed item and refetches once', async () => {
    const { user, onDelete, onUpdate } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Delete BETA' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onDelete).toHaveBeenCalledWith('BETA');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not refetch when the delete fails', async () => {
    const { user, onUpdate } = renderEditor({
      onDelete: vi.fn().mockRejectedValue(new Error('nope')),
    });

    await user.click(screen.getByRole('button', { name: 'Delete BETA' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when the delete is cancelled', async () => {
    const { user, onDelete } = renderEditor();

    await user.click(screen.getByRole('button', { name: 'Delete BETA' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
