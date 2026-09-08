import { Badge } from '@/components/ui/badge';
import type { SessionDisplayStatus } from '@/lib/session-display-status';

const statusVariants: Record<
  SessionDisplayStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  running: 'default',
  background: 'secondary',
  waiting: 'secondary',
  paused: 'outline',
  stopped: 'outline',
  creating: 'outline',
  error: 'destructive',
  archived: 'outline',
};

export function SessionStatusBadge({ status }: { status: SessionDisplayStatus }) {
  return <Badge variant={statusVariants[status]}>{status}</Badge>;
}
