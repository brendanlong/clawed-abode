'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ModelCombobox } from './ModelCombobox';
import type { SaveMutation } from './save-mutation';

interface ModelOverrideFieldProps {
  /** The currently saved override, or null when none is set. */
  currentModel: string | null;
  /** The value shown as the edit-input placeholder (a suggested model). */
  defaultModel: string;
  /** Persists the new value. Pass null to clear the override. Call onSuccess once the save succeeds. */
  onSave: (model: string | null, onSuccess: () => void) => void;
  mutation: SaveMutation;
  /** Text shown in the value box when no model is set. Defaults to {@link defaultModel}. */
  emptyLabel?: string;
  /** Muted hint next to the empty label (e.g. "(default)"). Pass null to hide. */
  emptyHint?: string | null;
  /** Button label shown when no override exists. */
  setButtonLabel?: string;
  /** Button label for clearing the current model. */
  clearButtonLabel?: string;
  /**
   * When true, saving with an empty input adopts {@link defaultModel} instead of
   * clearing to null. Used where "no model" is a distinct disabled state reached
   * via the clear button, so an empty save should mean "the suggested model".
   */
  emptySavesDefault?: boolean;
}

export function ModelOverrideField({
  currentModel,
  defaultModel,
  onSave,
  mutation,
  emptyLabel,
  emptyHint = '(default)',
  setButtonLabel = 'Override',
  clearButtonLabel = 'Reset to Default',
  emptySavesDefault = false,
}: ModelOverrideFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const startEditing = () => {
    setEditValue(currentModel ?? '');
    setIsEditing(true);
    mutation.reset();
  };

  const stopEditing = () => {
    setIsEditing(false);
    mutation.reset();
  };

  const handleSave = () => {
    if (mutation.isPending) return;
    const trimmed = editValue.trim();
    const value = trimmed || (emptySavesDefault ? defaultModel : null);
    onSave(value, () => setIsEditing(false));
  };

  if (isEditing) {
    return (
      <div className="space-y-3">
        <ModelCombobox
          value={editValue}
          onChange={setEditValue}
          placeholder={defaultModel}
          disabled={mutation.isPending}
          onSubmit={handleSave}
          onEscape={stopEditing}
          autoFocus
        />
        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={stopEditing}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
          {currentModel ?? emptyLabel ?? defaultModel}
        </code>
        {!currentModel && emptyHint && (
          <span className="text-xs text-muted-foreground">{emptyHint}</span>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={startEditing}>
          {currentModel ? 'Edit' : setButtonLabel}
        </Button>
        {currentModel && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSave(null, () => {})}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? <Spinner size="sm" /> : clearButtonLabel}
          </Button>
        )}
      </div>
      {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
    </div>
  );
}
