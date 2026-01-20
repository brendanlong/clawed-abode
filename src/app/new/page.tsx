'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface Repo {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

function RepoSelector({
  selectedRepo,
  onSelect,
}: {
  selectedRepo: Repo | null;
  onSelect: (repo: Repo) => void;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    trpc.github.listRepos.useInfiniteQuery(
      { search: debouncedSearch || undefined, perPage: 20 },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      }
    );

  const repos = data?.pages.flatMap((p) => p.repos) || [];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Search repositories</Label>
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your repositories..."
        />
      </div>

      <div className="border rounded-lg max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : repos.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No repositories found</div>
        ) : (
          <ul className="divide-y divide-border">
            {repos.map((repo) => (
              <li
                key={repo.id}
                onClick={() => onSelect(repo)}
                className={cn(
                  'px-4 py-3 cursor-pointer hover:bg-muted/50 transition-colors',
                  selectedRepo?.id === repo.id && 'bg-primary/10'
                )}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{repo.fullName}</p>
                    {repo.description && (
                      <p className="text-xs text-muted-foreground truncate max-w-md">
                        {repo.description}
                      </p>
                    )}
                  </div>
                  {repo.private && <span className="text-xs text-muted-foreground">Private</span>}
                </div>
              </li>
            ))}
            {hasNextPage && (
              <li className="px-4 py-3 text-center">
                <Button
                  variant="link"
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                >
                  {isFetchingNextPage ? 'Loading...' : 'Load more'}
                </Button>
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function BranchSelector({
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

function NewSessionForm() {
  const router = useRouter();
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [error, setError] = useState('');

  const createMutation = trpc.sessions.create.useMutation({
    onSuccess: (data) => {
      router.push(`/session/${data.session.id}`);
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!selectedRepo) {
      setError('Please select a repository');
      return;
    }

    if (!selectedBranch) {
      setError('Please select a branch');
      return;
    }

    createMutation.mutate({
      name: sessionName || `${selectedRepo.name} - ${selectedBranch}`,
      repoFullName: selectedRepo.fullName,
      branch: selectedBranch,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <RepoSelector selectedRepo={selectedRepo} onSelect={setSelectedRepo} />

      {selectedRepo && (
        <>
          <BranchSelector
            repoFullName={selectedRepo.fullName}
            selectedBranch={selectedBranch}
            onSelect={setSelectedBranch}
          />

          <div className="space-y-2">
            <Label htmlFor="sessionName">Session name (optional)</Label>
            <Input
              id="sessionName"
              type="text"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder={`${selectedRepo.name} - ${selectedBranch || 'branch'}`}
            />
          </div>
        </>
      )}

      <div className="flex justify-end gap-3">
        <Button variant="outline" asChild>
          <Link href="/">Cancel</Link>
        </Button>
        <Button
          type="submit"
          disabled={!selectedRepo || !selectedBranch || createMutation.isPending}
        >
          {createMutation.isPending ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" className="text-primary-foreground" />
              Creating...
            </span>
          ) : (
            'Create Session'
          )}
        </Button>
      </div>
    </form>
  );
}

export default function NewSessionPage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background">
        <Header />

        <main className="max-w-2xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <h1 className="text-2xl font-bold mb-6">New Session</h1>

            <Card>
              <CardHeader>
                <CardTitle>Create a new session</CardTitle>
              </CardHeader>
              <CardContent>
                <NewSessionForm />
              </CardContent>
            </Card>
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
