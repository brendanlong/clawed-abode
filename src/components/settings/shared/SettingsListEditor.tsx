'use client';

import { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Plus, Trash2 } from 'lucide-react';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import type { SettingsListState, SettingsListAction } from './settings-list-reducer';

interface SettingsListItem {
  id: string;
  name: string;
}

interface SettingsListEditorProps<T extends SettingsListItem> {
  title: string;
  items: T[];
  state: SettingsListState;
  dispatch: (action: SettingsListAction) => void;
  onDelete: () => void;
  emptyMessage: string;
  deleteDialogTitle: string;
  deleteDescriptionPrefix: string;
  renderItem: (item: T) => ReactNode;
  renderForm: (props: {
    existingItem: T | undefined;
    onClose: () => void;
    onSuccess: () => void;
  }) => ReactNode;
  extraItemActions?: (item: T) => ReactNode;
  renderItemExtra?: (item: T) => ReactNode;
}

export function SettingsListEditor<T extends SettingsListItem>({
  title,
  items,
  state,
  dispatch,
  onDelete,
  emptyMessage,
  deleteDialogTitle,
  deleteDescriptionPrefix,
  renderItem,
  renderForm,
  extraItemActions,
  renderItemExtra,
}: SettingsListEditorProps<T>) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{title}</h3>
        <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'openForm' })}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {items.length === 0 && !state.showForm ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="space-y-1">
              <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                <div className="flex-1 min-w-0">{renderItem(item)}</div>
                {extraItemActions?.(item)}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dispatch({ type: 'startEditing', id: item.id })}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => dispatch({ type: 'setDeleteTarget', name: item.name })}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {renderItemExtra?.(item)}
            </li>
          ))}
        </ul>
      )}

      {(state.showForm || state.editingId) &&
        renderForm({
          existingItem: state.editingId
            ? items.find((item) => item.id === state.editingId)
            : undefined,
          onClose: () => dispatch({ type: 'closeForm' }),
          onSuccess: () => dispatch({ type: 'formSuccess' }),
        })}

      <DeleteConfirmDialog
        open={!!state.deleteTarget}
        onClose={() => dispatch({ type: 'setDeleteTarget', name: null })}
        onConfirm={onDelete}
        title={deleteDialogTitle}
        description={
          <>
            {deleteDescriptionPrefix} <strong>{state.deleteTarget}</strong>.
          </>
        }
        isPending={state.isDeleting}
      />
    </div>
  );
}
