'use client';

import { Paperclip, X } from 'lucide-react';

interface AttachmentChipProps {
  /** File name to display. */
  name: string;
  /** Remove handler; the ✕ button is hidden when omitted. */
  onRemove?: () => void;
}

/**
 * A single pending-attachment chip (paperclip + truncated file name + optional
 * remove button). Shared by the session composer and the new-session form so
 * their attachment lists render identically.
 */
export function AttachmentChip({ name, onRemove }: AttachmentChipProps) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs">
      <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="max-w-[12rem] truncate" title={name}>
        {name}
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${name}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
