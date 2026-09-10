'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Plus, Trash2 } from 'lucide-react';
import {
  keepsStoredSecret,
  type KeyValueEntry,
  type SecretValueMap,
} from '@/lib/key-value-entries';

interface KeyValueListEditorProps {
  label: string;
  entries: KeyValueEntry[];
  existingEntries?: SecretValueMap;
  onChange: (entries: KeyValueEntry[]) => void;
  keyPlaceholder?: string;
  keyTransform?: (key: string) => string;
}

export function KeyValueListEditor({
  label,
  entries,
  existingEntries,
  onChange,
  keyPlaceholder = 'KEY',
  keyTransform,
}: KeyValueListEditorProps) {
  const addEntry = () => {
    onChange([...entries, { key: '', value: '', isSecret: false }]);
  };

  const removeEntry = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  };

  const updateEntry = (
    index: number,
    field: 'key' | 'value' | 'isSecret',
    value: string | boolean
  ) => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addEntry}
          aria-label={`Add to ${label}`}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={entry.key}
            onChange={(e) =>
              updateEntry(
                index,
                'key',
                keyTransform ? keyTransform(e.target.value) : e.target.value
              )
            }
            placeholder={keyPlaceholder}
            aria-label={`${label} name (row ${index + 1})`}
            className="flex-1"
          />
          <Input
            type={entry.isSecret ? 'password' : 'text'}
            value={entry.value}
            onChange={(e) => updateEntry(index, 'value', e.target.value)}
            placeholder={
              keepsStoredSecret(existingEntries?.[entry.key], entry.isSecret)
                ? '(unchanged)'
                : 'value'
            }
            aria-label={entry.key ? `${entry.key} value` : `${label} value (row ${index + 1})`}
            className="flex-1"
          />
          <Switch
            checked={entry.isSecret}
            onCheckedChange={(checked) => updateEntry(index, 'isSecret', checked)}
            title="Secret"
            aria-label={entry.key ? `${entry.key} is secret` : `Row ${index + 1} is secret`}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeEntry(index)}
            className="text-destructive"
            aria-label={entry.key ? `Remove ${entry.key}` : `Remove row ${index + 1}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
