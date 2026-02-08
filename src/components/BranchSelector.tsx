'use client';

import { useCallback, useEffect } from 'react';
import { trpc } from '@/lib/trpc';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function BranchSelector({
  repoFullName,
  selectedBranch,
  onSelect,
}: {
  repoFullName: string;
  selectedBranch: string;
  onSelect: (branch: string) => void;
}) {
  const { data, isLoading } = trpc.github.listBranches.useQuery(
    { repoFullName },
    { enabled: !!repoFullName }
  );

  const handleSelect = useCallback(
    (branch: string) => {
      onSelect(branch);
    },
    [onSelect]
  );

  useEffect(() => {
    if (data?.defaultBranch && !selectedBranch) {
      handleSelect(data.defaultBranch);
    }
  }, [data, selectedBranch, handleSelect]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Spinner size="sm" />
        <span>Loading branches...</span>
      </div>
    );
  }

  const branches = data?.branches || [];

  return (
    <div className="space-y-2">
      <Label>Branch</Label>
      <Select value={selectedBranch} onValueChange={onSelect}>
        <SelectTrigger>
          <SelectValue placeholder="Select a branch" />
        </SelectTrigger>
        <SelectContent>
          {branches.map((branch) => (
            <SelectItem key={branch.name} value={branch.name}>
              {branch.name}
              {branch.name === data?.defaultBranch ? ' (default)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
