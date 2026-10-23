'use client';

import {
  Activity,
  Archive,
  CircleAlert,
  CirclePause,
  Loader2,
  MessageCircle,
  PowerOff,
  type LucideIcon,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { SessionDisplayStatus } from '@/lib/session-display-status';
import { cn } from '@/lib/utils';

const statusIcons: Record<SessionDisplayStatus, { icon: LucideIcon; className: string }> = {
  running: { icon: Loader2, className: 'animate-spin text-primary' },
  background: { icon: Activity, className: 'text-primary' },
  waiting: { icon: MessageCircle, className: 'text-muted-foreground' },
  paused: { icon: CirclePause, className: 'text-amber-500' },
  stopped: { icon: PowerOff, className: 'text-muted-foreground' },
  creating: { icon: Loader2, className: 'animate-spin text-muted-foreground' },
  error: { icon: CircleAlert, className: 'text-destructive' },
  archived: { icon: Archive, className: 'text-muted-foreground' },
};

export function SessionStatusIcon({ status }: { status: SessionDisplayStatus }) {
  const { icon: Icon, className } = statusIcons[status];
  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={status}
            tabIndex={0}
            className="inline-flex h-11 w-11 items-center justify-center rounded-md"
          >
            <Icon className={cn('h-4 w-4', className)} />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{status}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
