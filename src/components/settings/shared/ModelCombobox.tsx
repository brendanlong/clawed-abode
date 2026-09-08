'use client';

import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
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

interface ModelComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Shown as the input placeholder (a suggested model). */
  placeholder: string;
  disabled?: boolean;
  /** Enter key. When omitted, Enter falls through to the surrounding form. */
  onSubmit?: () => void;
  /** Escape key, with the suggestion popover already closed. */
  onEscape?: () => void;
  autoFocus?: boolean;
}

/** A free-text model input with a suggestion popover fed by the server's model list. */
export function ModelCombobox({
  id,
  value,
  onChange,
  placeholder,
  disabled = false,
  onSubmit,
  onEscape,
  autoFocus = false,
}: ModelComboboxProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: suggestionsData } = trpc.globalSettings.getModelSuggestions.useQuery(undefined, {
    staleTime: 60 * 60 * 1000, // 1 hour
  });
  const suggestions = suggestionsData?.models ?? [];

  useEffect(() => {
    if (autoFocus) {
      const timer = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(timer);
    }
  }, [autoFocus]);

  const handleSelectSuggestion = (model: string) => {
    onChange(model);
    setPopoverOpen(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const filteredSuggestions = value.trim()
    ? suggestions.filter((s) => s.toLowerCase().includes(value.trim().toLowerCase()))
    : suggestions;

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <div className="relative">
          <Input
            id={id}
            ref={inputRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              if (e.target.value && !popoverOpen) {
                setPopoverOpen(true);
              }
            }}
            onFocus={() => setPopoverOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && onSubmit) {
                e.preventDefault();
                onSubmit();
              } else if (e.key === 'Escape') {
                if (popoverOpen) {
                  setPopoverOpen(false);
                } else {
                  onEscape?.();
                }
              }
            }}
            placeholder={placeholder}
            disabled={disabled}
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
                    className={cn('mr-2 h-4 w-4', value === model ? 'opacity-100' : 'opacity-0')}
                  />
                  {model}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
