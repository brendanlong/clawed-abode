'use client';

import { GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, GitMerge } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { PullRequestInfo, PrState } from '@/hooks/usePullRequestStatus';

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

interface PrStatusIndicatorProps {
  pullRequest: PullRequestInfo;
  className?: string;
}

export function PrStatusIndicator({ pullRequest, className }: PrStatusIndicatorProps) {
  const effectiveState: EffectivePrState =
    pullRequest.draft && pullRequest.state === 'open' ? 'draft' : pullRequest.state;

  const config = prStateConfig[effectiveState];
  const Icon = config.icon;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'inline-flex items-center justify-center p-1 rounded-md',
              'hover:bg-muted/50 transition-colors',
              config.colorClass,
              className
            )}
            onClick={(e) => e.stopPropagation()}
            aria-label={`PR #${pullRequest.number}: ${pullRequest.title} (${config.label})`}
          >
            <Icon className="w-4 h-4" />
          </a>
        </TooltipTrigger>
        <TooltipContent side="top">
          PR #{pullRequest.number}: {pullRequest.title} ({config.label})
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
