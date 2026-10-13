'use client';

import { useCallback, useState } from 'react';
import { ChevronRight, ShieldAlert } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

import { ColorBadge } from './ColorBadge';
import { CopyButton } from './CopyButton';
import { useMessageListContext } from './MessageListContext';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

/**
 * Display for `model_refusal_fallback` system messages: the API flagged a
 * request on the primary model and silently retried it on a fallback. Without a
 * banner the downgrade is invisible — the reply just comes back on a different
 * model.
 *
 * The primary model's retracted attempt, which the fallback redoes, is folded
 * under the banner, collapsed, so the transcript reads as one turn while the
 * original attempt stays one click away. Its tool calls did run, so it isn't
 * presented as undone.
 */
export function RefusalFallbackDisplay({
  messageId,
  content,
}: {
  messageId?: string;
  content: MessageContent;
}) {
  const getJsonText = useCallback(() => formatAsJson(content), [content]);
  const [showRetracted, setShowRetracted] = useState(false);
  const context = useMessageListContext();
  const retracted = messageId && context ? context.renderRetractedMessages(messageId) : null;

  const from = content.original_model ?? 'primary model';
  const to = content.fallback_model ?? 'fallback model';
  const category = content.api_refusal_category ?? undefined;
  // The API's user-facing explanation, falling back to the machine one.
  const explanation =
    (typeof content.content === 'string' ? content.content : undefined) ??
    content.api_refusal_explanation ??
    undefined;

  return (
    <div className="w-full">
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-medium">Model switched after refusal</span>
          {category && <ColorBadge color="amber">{category}</ColorBadge>}
        </div>
        <div className="mt-1 font-mono text-xs text-amber-800 dark:text-amber-200">
          {from} → {to}
        </div>
        {explanation && (
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">{explanation}</p>
        )}
      </div>
      <Collapsible open={showRetracted} onOpenChange={setShowRetracted}>
        <div className="mt-1 flex items-center gap-2">
          <CopyButton getText={getJsonText} />
          {retracted && (
            <CollapsibleTrigger className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
              <ChevronRight
                className={cn('h-3 w-3 transition-transform', showRetracted && 'rotate-90')}
              />
              {showRetracted ? 'Hide' : 'Show'} {from}&apos;s earlier attempt
            </CollapsibleTrigger>
          )}
        </div>
        {retracted && (
          <CollapsibleContent className="mt-2" data-retracted-messages>
            <p className="mb-2 text-xs text-muted-foreground">
              Retracted and redone on {to}. Any tool calls below still ran.
            </p>
            {retracted}
          </CollapsibleContent>
        )}
      </Collapsible>
    </div>
  );
}
