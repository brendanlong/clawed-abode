'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import type { ToolCall } from './types';

interface ToolDisplayWrapperProps {
  tool: ToolCall;
  /** Icon element to display before the title */
  icon?: React.ReactNode;
  /** Tool display name shown in the header */
  title: string;
  /** Custom pending badge text (default: "Running...") */
  pendingText?: string;
  /** Extra badges or metadata shown after the title and status badges */
  headerContent?: React.ReactNode;
  /** Description line below the title row */
  subtitle?: React.ReactNode;
  /** Custom done badge (replaces the default green "Done" badge). Set to null to hide. */
  doneBadge?: React.ReactNode | null;
  /** Additional card className for custom border colors etc. */
  cardClassName?: string;
  /** Override the default expand/collapse behavior */
  expandedOverride?: {
    expanded: boolean;
    onOpenChange: (open: boolean) => void;
  };
  /** Whether to start expanded (default: false) */
  defaultExpanded?: boolean;
  /** Override isPending computation (e.g. AskUserQuestionDisplay) */
  isPendingOverride?: boolean;
  /** Override isError computation (e.g. AskUserQuestionDisplay) */
  isErrorOverride?: boolean;
  /** Tool-specific content rendered inside the collapsible area */
  children: React.ReactNode;
}

/**
 * Shared wrapper for tool display components.
 * Handles the common collapsible card structure, status badges, and expand/collapse UI.
 */
export function ToolDisplayWrapper({
  tool,
  icon,
  title,
  pendingText = 'Running...',
  headerContent,
  subtitle,
  doneBadge,
  cardClassName,
  expandedOverride,
  defaultExpanded = false,
  isPendingOverride,
  isErrorOverride,
  children,
}: ToolDisplayWrapperProps) {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);

  const expanded = expandedOverride ? expandedOverride.expanded : localExpanded;
  const onOpenChange = expandedOverride ? expandedOverride.onOpenChange : setLocalExpanded;

  const hasOutput = tool.output !== undefined;
  const isPending = isPendingOverride ?? !hasOutput;
  const isError = isErrorOverride ?? !!tool.is_error;

  // Default done badge: green "Done" text
  const defaultDoneBadge = (
    <Badge
      variant="outline"
      className="text-xs border-green-500 text-green-700 dark:text-green-400"
    >
      Done
    </Badge>
  );

  const resolvedDoneBadge = doneBadge === undefined ? defaultDoneBadge : doneBadge;

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={onOpenChange}>
        <Card
          className={cn(
            'mt-2',
            isError && 'border-red-300 dark:border-red-700',
            isPending && 'border-yellow-300 dark:border-yellow-700',
            cardClassName
          )}
        >
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                {icon}
                <span className="font-mono text-primary">{title}</span>
                {headerContent}
                {isPending && (
                  <Badge
                    variant="outline"
                    className="text-xs border-yellow-500 text-yellow-700 dark:text-yellow-400"
                  >
                    {pendingText}
                  </Badge>
                )}
                {isError && (
                  <Badge variant="destructive" className="text-xs">
                    Error
                  </Badge>
                )}
                {hasOutput && !isError && resolvedDoneBadge}
              </div>
              {subtitle}
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-3 text-xs">{children}</CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
