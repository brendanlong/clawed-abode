import { Badge } from '@/components/ui/badge';
import type { SessionDisplayStatus } from '@/lib/session-display-status';

const statusVariants: Record<
  SessionDisplayStatus,
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  running: 'default',
  background: 'secondary',
  waiting: 'secondary',
  stopped: 'outline',
  creating: 'outline',
  error: 'destructive',
  archived: 'outline',
};

export function SessionStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={statusVariants[status as SessionDisplayStatus] || 'secondary'}>{status}</Badge>
  );
}
