'use client';

import { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';
import { CopyButton } from './CopyButton';
import { summarizeSystemMessage } from './messageHelpers';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

/**
 * Display for generic `system` messages (any subtype without a dedicated
 * renderer). Shows a concise, never-blank summary via {@link summarizeSystemMessage};
 * warn-level messages (retries, denials, errors) get an amber treatment.
 */
export function SystemMessageDisplay({ content }: { content: MessageContent }) {
  const { label, body, level } = summarizeSystemMessage(content);
  const warn = level === 'warn';
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  return (
    <div className="group">
      <div
        className={cn('rounded-lg p-3 text-sm', {
          'bg-muted text-muted-foreground': !warn,
          'border border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200':
            warn,
        })}
      >
        <Badge variant={warn ? 'outline' : 'secondary'} className="mb-1">
          {label}
        </Badge>
        {body && <MarkdownContent content={body} />}
      </div>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
