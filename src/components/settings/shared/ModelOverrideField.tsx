'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { trpc } from '@/lib/trpc';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModelOverrideFieldProps {
  /** The currently saved override, or null when none is set. */
  currentModel: string | null;
  /** The value that applies when no override is set (shown as placeholder). */
  defaultModel: string;
  /** Persists the new value. Pass null to clear the override. */
  onSave: (model: string | null) => void;
  isPending: boolean;
  error: string | null;
  /** Button label shown when no override exists. */
  setButtonLabel?: string;
}

export function ModelOverrideField({
  currentModel,
  defaultModel,
  onSave,
  isPending,
  error,
  setButtonLabel = 'Override',
}: ModelOverrideFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: suggestionsData } = trpc.globalSettings.getModelSuggestions.useQuery(undefined, {
    enabled: isEditing,
    staleTime: 60 * 60 * 1000, // 1 hour
  });
  const suggestions = suggestionsData?.models ?? [];

  const startEditing = () => {
    setEditValue(currentModel ?? '');
    setIsEditing(true);
  };

  useEffect(() => {
    if (isEditing) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [isEditing]);

  const handleSave = () => {
    onSave(editValue.trim() || null);
    setIsEditing(false);
  };

  const handleSelectSuggestion = (model: string) => {
    setEditValue(model);
    setPopoverOpen(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const filteredSuggestions = editValue.trim()
    ? suggestions.filter((s) => s.toLowerCase().includes(editValue.trim().toLowerCase()))
    : suggestions;

  if (isEditing) {
    return (
      <div className="space-y-3">
        <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
          <PopoverTrigger asChild>
            <div className="relative">
              <Input
                ref={inputRef}
                value={editValue}
                onChange={(e) => {
                  setEditValue(e.target.value);
                  if (e.target.value && !popoverOpen) {
                    setPopoverOpen(true);
                  }
                }}
                onFocus={() => setPopoverOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSave();
                  } else if (e.key === 'Escape') {
                    if (popoverOpen) {
                      setPopoverOpen(false);
                    } else {
                      setIsEditing(false);
                    }
                  }
                }}
                placeholder={defaultModel}
                className="font-mono text-sm pr-8"
              />
              <ChevronsUpDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 opacity-50" />
            </div>
          </PopoverTrigger>
          <PopoverContent
            className="p-0 w-[var(--radix-popover-trigger-width)]"
            align="start"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
          >
            <Command shouldFilter={false}>
              <CommandList>
                <CommandEmpty className="py-3 text-center text-sm text-muted-foreground">
                  No matching models
                </CommandEmpty>
                <CommandGroup>
                  {filteredSuggestions.map((model) => (
                    <CommandItem
                      key={model}
                      value={model}
                      onSelect={() => handleSelectSuggestion(model)}
                      className="font-mono text-sm cursor-pointer"
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          editValue === model ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {model}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setIsEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isPending}>
            {isPending ? <Spinner size="sm" /> : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
          {currentModel ?? defaultModel}
        </code>
        {!currentModel && <span className="text-xs text-muted-foreground">(default)</span>}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={startEditing}>
          {currentModel ? 'Edit' : setButtonLabel}
        </Button>
        {currentModel && (
          <Button variant="outline" size="sm" onClick={() => onSave(null)} disabled={isPending}>
            {isPending ? <Spinner size="sm" /> : 'Reset to Default'}
          </Button>
        )}
      </div>
    </div>
  );
}
