'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Plus, Trash2 } from 'lucide-react';

interface KeyValueEntry {
  key: string;
  value: string;
  isSecret: boolean;
}

interface KeyValueListEditorProps {
  label: string;
  entries: KeyValueEntry[];
  existingEntries?: Record<string, { value: string; isSecret: boolean }>;
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
        <Button type="button" variant="outline" size="sm" onClick={addEntry}>
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
            className="flex-1"
          />
          <Input
            type={entry.isSecret ? 'password' : 'text'}
            value={entry.value}
            onChange={(e) => updateEntry(index, 'value', e.target.value)}
            placeholder={existingEntries?.[entry.key]?.isSecret ? '(unchanged)' : 'value'}
            className="flex-1"
          />
          <Switch
            checked={entry.isSecret}
            onCheckedChange={(checked) => updateEntry(index, 'isSecret', checked)}
            title="Secret"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeEntry(index)}
            className="text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}
