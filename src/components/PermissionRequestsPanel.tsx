'use client';

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  permissionInputPreview,
  permissionRequestTitle,
  type PermissionRequest,
} from '@/lib/permission-request';

export type RespondToPermission = (
  toolUseId: string,
  allow: boolean,
  feedback?: string
) => Promise<unknown>;

function PermissionRequestCard({
  request,
  onRespond,
}: {
  request: PermissionRequest;
  onRespond: RespondToPermission;
}) {
  const [feedback, setFeedback] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const respond = (allow: boolean) => {
    setSubmitting(true);
    setError(null);
    onRespond(request.toolUseId, allow, allow ? undefined : feedback).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to respond');
      setSubmitting(false);
    });
  };

  return (
    <div className="rounded-md border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3 space-y-2">
      <div className="flex items-start gap-2">
        <ShieldAlert className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{permissionRequestTitle(request)}</span>
            {request.agentId && <Badge variant="outline">subagent</Badge>}
          </div>
          {request.description && (
            <p className="text-xs text-muted-foreground">{request.description}</p>
          )}
          {request.reason && <p className="text-xs text-muted-foreground">{request.reason}</p>}
        </div>
      </div>
      <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">
        {permissionInputPreview(request.input)}
      </pre>
      <Textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Optional: tell Claude why (sent if you deny)"
        className="min-h-0 text-sm"
        rows={1}
        disabled={submitting}
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={() => respond(false)} disabled={submitting}>
          Deny
        </Button>
        <Button size="sm" onClick={() => respond(true)} disabled={submitting}>
          Allow
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Tool calls the permission mode asked the user about (doc/claude-sessions.md). */
export function PermissionRequestsPanel({
  requests,
  onRespond,
}: {
  requests: PermissionRequest[];
  onRespond: RespondToPermission;
}) {
  if (requests.length === 0) return null;
  return (
    <div className="px-4 pb-2 space-y-2 max-h-[50vh] overflow-y-auto">
      {requests.map((request) => (
        <PermissionRequestCard key={request.toolUseId} request={request} onRespond={onRespond} />
      ))}
    </div>
  );
}
