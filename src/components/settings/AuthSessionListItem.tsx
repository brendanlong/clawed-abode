'use client';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Spinner } from '@/components/ui/spinner';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers';
import { formatFullTimestamp } from '@/lib/message-timestamp';
import { trpc } from '@/lib/trpc';

type AuthSession = inferRouterOutputs<AppRouter>['auth']['listSessions']['sessions'][number];

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function parseUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';

  let browser = 'Unknown browser';
  let os = 'Unknown OS';

  if (userAgent.includes('Chrome') && !userAgent.includes('Edg')) {
    browser = 'Chrome';
  } else if (userAgent.includes('Firefox')) {
    browser = 'Firefox';
  } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
    browser = 'Safari';
  } else if (userAgent.includes('Edg')) {
    browser = 'Edge';
  }

  if (userAgent.includes('Windows')) {
    os = 'Windows';
  } else if (userAgent.includes('Mac OS')) {
    os = 'macOS';
  } else if (userAgent.includes('Linux')) {
    os = 'Linux';
  } else if (userAgent.includes('Android')) {
    os = 'Android';
  } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
    os = 'iOS';
  }

  return `${browser} on ${os}`;
}

export function AuthSessionListItem({ session }: { session: AuthSession }) {
  const utils = trpc.useUtils();
  const revokeMutation = trpc.auth.deleteSession.useMutation({
    onSuccess: () => utils.auth.listSessions.invalidate(),
  });
  const { state } = session;

  return (
    <li className="px-4 py-4 hover:bg-muted/50 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">{parseUserAgent(session.userAgent)}</span>
            {session.isCurrent && (
              <Badge variant="secondary" className="text-xs">
                Current session
              </Badge>
            )}
            {session.scope === 'public_files' && (
              <Badge variant="outline" className="text-xs">
                Public files only
              </Badge>
            )}
            {state === 'revoked' && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Revoked
              </Badge>
            )}
            {state === 'idle' && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Idle timeout
              </Badge>
            )}
            {state === 'expired' && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Expired
              </Badge>
            )}
          </div>

          <div className="text-xs text-muted-foreground space-y-0.5">
            {session.ipAddress && <p>IP: {session.ipAddress}</p>}
            <p>Last active: {formatRelativeTime(session.lastActivityAt)}</p>
            {session.revokedAt && <p>Revoked: {formatFullTimestamp(session.revokedAt)}</p>}
            {/* A revoked session's expiry is moot; it shows when it was revoked instead. */}
            {state !== 'revoked' && (
              <p>
                {state === 'active' ? 'Expires' : 'Expired'}:{' '}
                {formatFullTimestamp(session.effectiveExpiresAt)}
                {state === 'idle' && ' (idle)'}
              </p>
            )}
            <p>Created: {formatFullTimestamp(session.createdAt)}</p>
            {revokeMutation.error && (
              <p className="text-destructive">Failed to revoke: {revokeMutation.error.message}</p>
            )}
          </div>
        </div>

        {!session.isCurrent && state === 'active' && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={revokeMutation.isPending}>
                {revokeMutation.isPending ? <Spinner size="sm" /> : 'Revoke'}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke this session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will immediately log out this session. The device will need to log in again
                  to access the application.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => revokeMutation.mutate({ sessionId: session.id })}>
                  Revoke session
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </li>
  );
}
