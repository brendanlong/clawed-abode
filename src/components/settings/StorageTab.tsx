'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsCard } from './shared/SettingsCard';
import { trpc } from '@/lib/trpc';
import { formatBytes } from '@/lib/disk-usage';

export function StorageTab() {
  // Each fetch walks every workspace, so only rescan when asked.
  const { data, isLoading, isFetching, refetch, error } = trpc.sessions.diskUsage.useQuery(
    undefined,
    { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false }
  );

  return (
    <SettingsCard
      title="Workspace Disk Usage"
      description="Space each session's workspace would free if archived. Files hardlinked from shared caches (like the pnpm store) aren't counted."
      isLoading={isLoading}
    >
      {error && <p className="text-sm text-destructive mb-4">{error.message}</p>}
      {data && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>
              {formatBytes(data.filesystem.freeBytes)} free of{' '}
              {formatBytes(data.filesystem.totalBytes)} · measured{' '}
              {data.measuredAt.toLocaleTimeString()}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
              Rescan
            </Button>
          </div>
          {data.sessions.length > 0 ? (
            <ul className="divide-y divide-border">
              {data.sessions.map((session) => (
                <li key={session.id}>
                  <Link
                    href={`/session/${session.id}`}
                    className="flex items-center justify-between gap-4 py-2 hover:bg-muted/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{session.name}</span>
                      <span className="text-xs text-muted-foreground">{session.status}</span>
                    </span>
                    <span className="shrink-0 tabular-nums">{formatBytes(session.bytes)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No sessions have a workspace.</p>
          )}
        </div>
      )}
    </SettingsCard>
  );
}
