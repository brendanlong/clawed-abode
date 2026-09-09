'use client';

import { useNowTick } from '@/hooks/useNowTick';
import { formatFullTimestamp, formatMessageTimestamp } from '@/lib/message-timestamp';

/**
 * Small muted timestamp for a turn boundary. Each instance ticks on its own so a
 * day rollover only re-renders the timestamps, not the whole transcript.
 */
export function MessageTimestamp({ createdAt }: { createdAt?: Date }) {
  if (!createdAt) return null;
  return <TickingTimestamp createdAt={createdAt} />;
}

function TickingTimestamp({ createdAt }: { createdAt: Date }) {
  const now = useNowTick();
  return (
    <time
      dateTime={createdAt.toISOString()}
      title={formatFullTimestamp(createdAt)}
      className="text-xs text-muted-foreground whitespace-nowrap"
    >
      {formatMessageTimestamp(createdAt, new Date(now))}
    </time>
  );
}
