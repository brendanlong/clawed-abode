'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { resolveListQueryState } from '@/lib/list-query-state';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';

export function BranchSelector({
  repoFullName,
  selectedBranch,
  onSelect,
}: {
  repoFullName: string;
  selectedBranch: string;
  onSelect: (branch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = trpc.github.listBranches.useQuery(
    { repoFullName },
    { enabled: !!repoFullName }
  );

  const branches = data?.branches ?? [];
  const state = resolveListQueryState({
    isLoading,
    hasError: !!error,
    itemCount: branches.length,
  });

  useEffect(() => {
    if (data && data.branches.length > 0 && !selectedBranch) {
      onSelect(data.defaultBranch);
    }
  }, [data, selectedBranch, onSelect]);

  if (state === 'loading') {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Spinner size="sm" />
        <span>Loading branches...</span>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-2">
        <Label>Branch</Label>
        <p className="text-sm text-destructive">Could not load branches: {error?.message}</p>
      </div>
    );
  }

  if (state === 'empty') {
    return (
      <div className="space-y-2">
        <Label>Branch</Label>
        <p className="text-sm text-muted-foreground">
          No branches found. The repository may be empty.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label>Branch</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{selectedBranch || 'Select a branch'}</span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="p-0 w-[var(--radix-popover-trigger-width)]" align="start">
          <Command>
            <CommandInput placeholder="Search branches..." />
            <CommandList>
              <CommandEmpty>No matching branches</CommandEmpty>
              <CommandGroup>
                {branches.map((branch) => (
                  <CommandItem
                    key={branch}
                    value={branch}
                    onSelect={() => {
                      onSelect(branch);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(selectedBranch === branch ? 'opacity-100' : 'opacity-0')}
                    />
                    <span className="truncate">
                      {branch}
                      {branch === data?.defaultBranch ? ' (default)' : ''}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
