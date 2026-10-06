'use client';

import { useCallback } from 'react';
import { MessagesSquare } from 'lucide-react';

import { MarkdownContent } from '@/components/MarkdownContent';
import { parseInjectedOrigin } from '@/lib/claude-messages';
import { CopyButton } from './CopyButton';
import { MessageTimestamp } from './MessageTimestamp';
import { extractTextContent } from './messageHelpers';
import type { MessageContent } from './types';

/**
 * A user message another Claude session (or an MCP channel) sent this one.
 * Rendered apart from the user's own prompts so it never reads as something the
 * user typed.
 */
export function InjectedMessageDisplay({
  content,
  createdAt,
}: {
  content: MessageContent;
  createdAt?: Date;
}) {
  const origin = parseInjectedOrigin(content.origin);
  const text = origin?.body ?? extractTextContent(content) ?? '';
  const getText = useCallback(() => text, [text]);

  return (
    <div className="w-full">
      <div className="rounded-lg border border-dashed bg-muted/50 p-4">
        <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessagesSquare className="h-3.5 w-3.5" />
          <span>
            From <span className="font-mono">{origin?.sender ?? 'another session'}</span>
          </span>
        </div>
        <MarkdownContent content={text} />
      </div>
      <div className="mt-1 flex items-center gap-1">
        <CopyButton getText={getText} />
        <MessageTimestamp createdAt={createdAt} />
      </div>
    </div>
  );
}
