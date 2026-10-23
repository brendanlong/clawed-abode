import { Paperclip, X } from 'lucide-react';
import type { UploadedAttachment } from '@/lib/attachments';

export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: UploadedAttachment;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs">
      <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="max-w-[12rem] truncate" title={attachment.name}>
        {attachment.name}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground"
        aria-label={`Remove ${attachment.name}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
