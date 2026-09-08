'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { Plus, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SaveMutation } from './save-mutation';

interface EditableTextSettingProps {
  /** The saved text, or null when nothing is set. */
  value: string | null;
  /** Persists the trimmed draft; null when the draft is blank. Call onSuccess once saved. */
  onSave: (value: string | null, onSuccess: () => void) => void;
  mutation: SaveMutation;
  placeholder: string;
  /** Button label shown when no value is saved. */
  addLabel: string;
  /** Button label shown when a value is saved. */
  editLabel?: string;
  /** What the editor opens with when no value is saved. Defaults to empty. */
  emptyDraft?: string;
  /**
   * When set, the editor shows a labelled "Reset to Default" action that replaces the
   * draft with this text.
   */
  resetTo?: { label: string; value: string };
  textareaClassName?: string;
  previewClassName?: string;
}

export function EditableTextSetting({
  value,
  onSave,
  mutation,
  placeholder,
  addLabel,
  editLabel = 'Edit',
  emptyDraft = '',
  resetTo,
  textareaClassName,
  previewClassName,
}: EditableTextSettingProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const startEditing = () => {
    setDraft(value ?? emptyDraft);
    setIsEditing(true);
  };

  const handleCancel = () => {
    setIsEditing(false);
    mutation.reset();
  };

  const handleSave = () => {
    onSave(draft.trim() || null, () => setIsEditing(false));
  };

  if (isEditing) {
    return (
      <div className="space-y-3">
        {resetTo && (
          <div className="flex items-center justify-between">
            <Label>{resetTo.label}</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft(resetTo.value)}
              className="text-xs"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset to Default
            </Button>
          </div>
        )}
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          className={cn('min-h-[120px] font-mono text-sm', textareaClassName)}
        />
        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  if (value) {
    return (
      <div className="space-y-3">
        <div className={cn('rounded-md bg-muted/50 p-3 overflow-y-auto', previewClassName)}>
          <pre className="text-sm whitespace-pre-wrap font-mono">{value}</pre>
        </div>
        <Button variant="outline" size="sm" onClick={startEditing}>
          {editLabel}
        </Button>
      </div>
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={startEditing}>
      <Plus className="h-4 w-4 mr-1" />
      {addLabel}
    </Button>
  );
}
