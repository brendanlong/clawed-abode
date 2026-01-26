'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAuthSessions } from '@/hooks/useAuthSessions';
import { AuthSessionListItem } from './AuthSessionListItem';
import { trpc } from '@/lib/trpc';

/**
 * Tab component for managing auth sessions.
 * Shows active sessions with ability to expire them, and a toggle to show expired sessions.
 */
export function AuthSessionsTab() {
  const [showExpired, setShowExpired] = useState(false);
  const { sessions, isLoading, refetch } = useAuthSessions();

  const deleteMutation = trpc.auth.deleteSession.useMutation({
    onSuccess: () => {
      refetch();
    },
  });

  const handleExpireSession = async (sessionId: string) => {
    await deleteMutation.mutateAsync({ sessionId });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  const now = new Date();
  const activeSessions = sessions.filter((s) => new Date(s.expiresAt) > now);
  const expiredSessions = sessions.filter((s) => new Date(s.expiresAt) <= now);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="py-4">
          <CardTitle className="text-base">Active Sessions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {activeSessions.length > 0 ? (
            <ul className="divide-y divide-border">
              {activeSessions.map((session) => (
                <AuthSessionListItem
                  key={session.id}
                  session={session}
                  isExpired={false}
                  onExpire={handleExpireSession}
                />
              ))}
            </ul>
          ) : (
            <div className="p-6 text-center text-muted-foreground">No active sessions found.</div>
          )}
        </CardContent>
      </Card>

      {/* Toggle for expired sessions */}
      <div className="flex justify-center">
        <Button variant="ghost" size="sm" onClick={() => setShowExpired(!showExpired)}>
          {showExpired ? 'Hide expired sessions' : 'Show expired sessions'}
        </Button>
      </div>

      {/* Expired sessions section */}
      {showExpired && expiredSessions.length > 0 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Expired Sessions
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {expiredSessions.map((session) => (
                <AuthSessionListItem
                  key={session.id}
                  session={session}
                  isExpired={true}
                  onExpire={handleExpireSession}
                />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {showExpired && expiredSessions.length === 0 && (
        <div className="text-center text-sm text-muted-foreground">No expired sessions</div>
      )}
    </div>
  );
}
