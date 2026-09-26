'use client';

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { resolveListQueryState } from '@/lib/list-query-state';
import { capMatches, matchesAllTerms } from '@/lib/search';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { SearchableCombobox } from '@/components/SearchableCombobox';

/** Most branches the picker renders at once; big repos have hundreds. */
export const BRANCH_PICKER_LIMIT = 100;

export function BranchSelector({
  repoFullName,
  selectedBranch,
  onSelect,
}: {
  repoFullName: string;
  selectedBranch: string;
  onSelect: (branch: string) => void;
}) {
  const [query, setQuery] = useState('');
  const { data, isLoading, error } = trpc.github.listBranches.useQuery(
    { repoFullName },
    // Listing a big repo walks several GitHub pages; don't redo it on every tab focus.
    { enabled: !!repoFullName, staleTime: 5 * 60 * 1000 }
  );

  const branches = useMemo(() => data?.branches ?? [], [data]);
  const state = resolveListQueryState({
    isLoading,
    hasError: !!error,
    itemCount: branches.length,
  });

  const cap = useMemo(
    () =>
      capMatches(
        branches.filter((b) => matchesAllTerms(b, query)),
        BRANCH_PICKER_LIMIT,
        (b) => b === selectedBranch
      ),
    [branches, query, selectedBranch]
  );

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
      <SearchableCombobox
        triggerLabel={selectedBranch || 'Select a branch'}
        ariaLabel="Branch"
        searchPlaceholder="Search branches..."
        emptyText="No matching branches"
        query={query}
        onQueryChange={setQuery}
        options={cap.matches.map((branch) => ({
          value: branch,
          label: branch === data?.defaultBranch ? `${branch} (default)` : branch,
          selected: branch === selectedBranch,
        }))}
        onSelect={onSelect}
        cap={{ ...cap, noun: 'branches' }}
        footer={
          data?.truncated && (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              This repository has too many branches to list them all; some are missing.
            </p>
          )
        }
      />
    </div>
  );
}
