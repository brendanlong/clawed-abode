'use client';

import { useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CappedMatches } from '@/lib/search';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export interface ComboboxOption {
  value: string;
  label: string;
  selected: boolean;
}

interface SearchableComboboxProps {
  triggerLabel: string;
  ariaLabel?: string;
  searchPlaceholder: string;
  emptyText: string;
  /** Owned by the caller so it can filter (and cap) `options` itself. Cleared on close. */
  query: string;
  onQueryChange: (query: string) => void;
  options: readonly ComboboxOption[];
  onSelect: (value: string) => void;
  /** When the caller capped its matches, tells the user to keep typing. */
  cap?: CappedMatches<unknown> & { noun: string };
  footer?: ReactNode;
}

/** A popover picker whose search is done by the caller; options mount only while open. */
export function SearchableCombobox({
  triggerLabel,
  ariaLabel,
  searchPlaceholder,
  emptyText,
  query,
  onQueryChange,
  options,
  onSelect,
  cap,
  footer,
}: SearchableComboboxProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) onQueryChange('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
        <Command shouldFilter={false} defaultValue={options.find((o) => o.selected)?.value}>
          <CommandInput
            placeholder={searchPlaceholder}
            value={query}
            onValueChange={onQueryChange}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => {
                    onSelect(option.value);
                    setOpen(false);
                    onQueryChange('');
                  }}
                >
                  <Check className={cn('h-4 w-4', option.selected ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {cap && cap.total > cap.matches.length && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Showing {cap.matches.length} of {cap.total.toLocaleString()} {cap.noun}. Keep typing
              to narrow the list.
            </p>
          )}
          {footer}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
