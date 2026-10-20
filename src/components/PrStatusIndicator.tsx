'use client';

import { GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, GitMerge } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  describeChecks,
  type ChecksState,
  type PullRequestInfo,
  type PrState,
} from '@/lib/pull-request';

type EffectivePrState = PrState | 'draft';

interface PrStateConfig {
  icon: typeof GitPullRequest;
  colorClass: string;
  label: string;
}

const prStateConfig: Record<EffectivePrState, PrStateConfig> = {
  open: {
    icon: GitPullRequest,
    colorClass: 'text-green-600 dark:text-green-400',
    label: 'Open',
  },
  draft: {
    icon: GitPullRequestDraft,
    colorClass: 'text-muted-foreground',
    label: 'Draft',
  },
  merged: {
    icon: GitMerge,
    colorClass: 'text-purple-600 dark:text-purple-400',
    label: 'Merged',
  },
  closed: {
    icon: GitPullRequestClosed,
    colorClass: 'text-red-600 dark:text-red-400',
    label: 'Closed',
  },
};

/** Only for open PRs, and only once there's something to say. */
const checksDotClass: Partial<Record<ChecksState, string>> = {
  pending: 'bg-amber-500',
  success: 'bg-green-600 dark:bg-green-400',
  failure: 'bg-red-600 dark:bg-red-400',
};

interface PrStatusIndicatorProps {
  pullRequest: PullRequestInfo;
  className?: string;
}

export function PrStatusIndicator({ pullRequest, className }: PrStatusIndicatorProps) {
  const effectiveState: EffectivePrState =
    pullRequest.draft && pullRequest.state === 'open' ? 'draft' : pullRequest.state;

  const config = prStateConfig[effectiveState];
  const Icon = config.icon;
  const dotClass =
    pullRequest.state === 'open' && pullRequest.checks
      ? checksDotClass[pullRequest.checks]
      : undefined;
  const label = `PR #${pullRequest.number}: ${pullRequest.title} (${config.label}${dotClass ? `, ${describeChecks(pullRequest.checks)}` : ''})`;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'relative inline-flex items-center justify-center p-1 rounded-md',
              'hover:bg-muted/50 transition-colors',
              config.colorClass,
              className
            )}
            onClick={(e) => e.stopPropagation()}
            aria-label={label}
          >
            <Icon className="w-4 h-4" />
            {dotClass && (
              <span
                className={cn(
                  'absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background',
                  dotClass
                )}
              />
            )}
          </a>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
