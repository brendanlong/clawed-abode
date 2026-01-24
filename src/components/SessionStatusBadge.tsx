import { Badge } from '@/components/ui/badge';

type SessionStatus = 'running' | 'stopped' | 'creating' | 'error' | 'archived';

const statusVariants: Record<SessionStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  stopped: 'secondary',
  creating: 'outline',
  error: 'destructive',
  archived: 'outline',
};

export function SessionStatusBadge({ status }: { status: string }) {
  return <Badge variant={statusVariants[status as SessionStatus] || 'secondary'}>{status}</Badge>;
}
