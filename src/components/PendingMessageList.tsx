'use client';

import { Paperclip, X, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PendingMessage } from '@/lib/pending-message';

interface PendingMessageListProps {
  messages: PendingMessage[];
  onCancel: (id: string) => void;
}

/**
 * Renders the client-held pending queue pinned at the bottom of the transcript
 * (below the persisted messages), in first-to-last order. Each is a user-styled
 * bubble marked "Queued" with an ✕ to remove it before it sends. These are not
 * persisted — they flush together via `claude.sendBatch` when the turn ends, or
 * are reclaimed into the composer on interrupt. See {@link PendingMessage}.
 */
export function PendingMessageList({ messages, onCancel }: PendingMessageListProps) {
  if (messages.length === 0) return null;

  return (
    <div className="mt-4 flex flex-col gap-2">
      {messages.map((message) => (
        <div key={message.id} className="flex justify-end">
          <div className="group max-w-[85%]">
            <div
              className={cn(
                'rounded-lg p-4 ml-auto border border-dashed',
                'bg-primary/10 border-primary/40 text-foreground'
              )}
            >
              {message.text && (
                <p className="whitespace-pre-wrap break-words text-sm">{message.text}</p>
              )}

              {message.attachments.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {message.attachments.map((att) => (
                    <span
                      key={att.storedName}
                      className="inline-flex items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs"
                    >
                      <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="max-w-[12rem] truncate" title={att.name}>
                        {att.name}
                      </span>
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  Queued
                </span>
                <button
                  type="button"
                  onClick={() => onCancel(message.id)}
                  className="inline-flex items-center gap-1 hover:text-foreground"
                  aria-label="Remove queued message"
                >
                  <X className="h-3 w-3" />
                  Remove
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
