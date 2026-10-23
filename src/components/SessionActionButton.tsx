'use client';

import { useState } from 'react';
import { Archive, Play, Square, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
import { cn } from '@/lib/utils';

type ButtonVariant = 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline' | 'link';

interface SessionActionButtonProps {
  action: 'start' | 'stop' | 'archive';
  onClick: () => void;
  isPending: boolean;
  variant?: ButtonVariant;
  sessionName?: string;
  /** Renders a text button with this label instead of an icon button. */
  label?: string;
  className?: string;
}

const actionConfig: Record<
  SessionActionButtonProps['action'],
  { label: string; pendingLabel: string; icon: LucideIcon }
> = {
  start: { label: 'Start', pendingLabel: 'Starting...', icon: Play },
  stop: { label: 'Stop', pendingLabel: 'Stopping...', icon: Square },
  archive: { label: 'Archive', pendingLabel: 'Archiving...', icon: Archive },
};

const archiveConfirmTitle = 'Archive session?';
const archiveConfirmDescription = (name: string) =>
  `This will archive the session "${name}" and remove its workspace. You can still view the message history in archived sessions.`;

/**
 * Button for session actions (start, stop, archive): an icon button with a
 * tooltip, or a text button when given a `label`. Archive asks for confirmation.
 */
export function SessionActionButton({
  action,
  onClick,
  isPending,
  variant = 'default',
  sessionName,
  label,
  className,
}: SessionActionButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const config = actionConfig[action];
  const Icon = config.icon;
  const accessibleLabel = isPending ? config.pendingLabel : config.label;
  const isArchive = action === 'archive';

  const button = (
    <Button
      variant={variant}
      size={label ? 'sm' : 'icon'}
      onClick={isArchive ? undefined : onClick}
      disabled={isPending}
      aria-label={label ? undefined : accessibleLabel}
      className={cn(isArchive && 'text-muted-foreground', !label && 'h-11 w-11', className)}
    >
      {isPending ? <Spinner size="sm" /> : !label && <Icon />}
      {label && (isPending ? config.pendingLabel : label)}
    </Button>
  );

  const trigger =
    isArchive && !isPending ? <AlertDialogTrigger asChild>{button}</AlertDialogTrigger> : button;

  const withTooltip = label ? (
    trigger
  ) : (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent side="top">{accessibleLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );

  if (!isArchive) return withTooltip;

  return (
    <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
      {withTooltip}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{archiveConfirmTitle}</AlertDialogTitle>
          <AlertDialogDescription>
            {archiveConfirmDescription(sessionName ?? 'this session')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onClick();
              setDialogOpen(false);
            }}
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
