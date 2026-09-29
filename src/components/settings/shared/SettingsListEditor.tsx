'use client';

import { Fragment, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from 'lucide-react';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';

interface SettingsListItem {
  id: string;
  name: string;
}

/** Global lists say so in their copy; repo lists are the unqualified default. */
export type SettingsScope = 'global' | 'repo';

interface SettingsListEditorProps<T extends SettingsListItem> {
  title: string;
  /** Singular, lower-case item name used in the copy, e.g. "MCP server". */
  itemNoun: string;
  scope: SettingsScope;
  items: T[];
  onDelete: (name: string) => Promise<unknown>;
  onUpdate: () => void;
  renderItem: (item: T) => ReactNode;
  renderForm: (props: {
    existingItem: T | undefined;
    onClose: () => void;
    onSuccess: () => void;
  }) => ReactNode;
  extraItemActions?: (item: T) => ReactNode;
  renderItemExtra?: (item: T) => ReactNode;
}

/** Which form is open: the add form, the edit form for an item id, or none. */
type Editing = 'new' | string | null;

export function SettingsListEditor<T extends SettingsListItem>({
  title,
  itemNoun,
  scope,
  items,
  onDelete,
  onUpdate,
  renderItem,
  renderForm,
  extraItemActions,
  renderItemExtra,
}: SettingsListEditorProps<T>) {
  const [editing, setEditing] = useState<Editing>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const scopedNoun = scope === 'global' ? `global ${itemNoun}` : itemNoun;
  const editingItem =
    editing !== null && editing !== 'new' ? items.find((item) => item.id === editing) : undefined;
  const formOpen = editing === 'new' || editingItem !== undefined;

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await onDelete(deleteTarget);
      onUpdate();
    } catch {
      // Nothing was deleted, so there's nothing to refetch.
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{title}</h3>
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {items.length === 0 && !formOpen ? (
        <p className="text-sm text-muted-foreground">No {scopedNoun}s configured.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="space-y-1">
              <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                <div className="flex-1 min-w-0">{renderItem(item)}</div>
                {extraItemActions?.(item)}
                <Button variant="ghost" size="sm" onClick={() => setEditing(item.id)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeleteTarget(item.name)}
                  className="text-destructive hover:text-destructive"
                  aria-label={`Delete ${item.name}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {renderItemExtra?.(item)}
            </li>
          ))}
        </ul>
      )}

      {/* Keyed by the target: the forms seed their state from existingItem on
          mount, so switching targets must remount rather than reuse the form. */}
      {formOpen && (
        <Fragment key={editing}>
          {renderForm({
            existingItem: editingItem,
            onClose: () => setEditing(null),
            onSuccess: () => {
              setEditing(null);
              onUpdate();
            },
          })}
        </Fragment>
      )}

      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={`Delete ${itemNoun}?`}
        description={
          <>
            This will delete the {scopedNoun} <strong>{deleteTarget}</strong>.
          </>
        }
      />
    </div>
  );
}
