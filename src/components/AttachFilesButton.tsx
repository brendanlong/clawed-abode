'use client';

import { useRef, type ComponentProps } from 'react';
import { Paperclip } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

type AttachFilesButtonProps = Pick<
  ComponentProps<typeof Button>,
  'variant' | 'size' | 'disabled' | 'children'
> & {
  /** Called with the picked files (never empty). */
  onSelect: (files: File[]) => void;
  /** Shows a spinner and disables the button while an upload is in flight. */
  uploading: boolean;
};

/** A paperclip button that opens the browser's multi-file picker. */
export function AttachFilesButton({
  onSelect,
  uploading,
  disabled,
  children,
  ...buttonProps
}: AttachFilesButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          if (files.length > 0) onSelect(files);
          // Reset so selecting the same file again re-triggers onChange.
          e.currentTarget.value = '';
        }}
      />
      <Button
        type="button"
        {...buttonProps}
        onClick={() => inputRef.current?.click()}
        disabled={disabled || uploading}
        title="Attach files"
        aria-label="Attach files"
      >
        {uploading ? (
          <Spinner size="sm" className="text-current" />
        ) : (
          <Paperclip className="h-4 w-4" />
        )}
        {children}
      </Button>
    </>
  );
}
