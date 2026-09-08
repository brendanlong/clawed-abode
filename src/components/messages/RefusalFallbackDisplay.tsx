'use client';

import { useCallback } from 'react';
import { ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

/**
 * Display for `model_refusal_fallback` system messages: the API flagged a
 * request on the primary model and silently retried it on a fallback. Without a
 * banner the downgrade is invisible — the reply just comes back on a different
 * model.
 */
export function RefusalFallbackDisplay({ content }: { content: MessageContent }) {
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  const from = content.original_model ?? 'primary model';
  const to = content.fallback_model ?? 'fallback model';
  const category = content.api_refusal_category ?? undefined;
  // The API's user-facing explanation, falling back to the machine one.
  const explanation =
    (typeof content.content === 'string' ? content.content : undefined) ??
    content.api_refusal_explanation ??
    undefined;

  return (
    <div className="group w-full">
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="font-medium">Model switched after refusal</span>
          {category && (
            <Badge
              variant="outline"
              className="border-amber-500 text-amber-700 dark:text-amber-300"
            >
              {category}
            </Badge>
          )}
        </div>
        <div className="mt-1 font-mono text-xs text-amber-800 dark:text-amber-200">
          {from} → {to}
        </div>
        {explanation && (
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">{explanation}</p>
        )}
      </div>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
