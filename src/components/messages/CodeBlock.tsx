'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { highlightCode } from '@/lib/syntax-highlight';

/**
 * Renders a block of code with syntax highlighting (via highlight.js) in the
 * normal foreground color. `fileType` is a {@link getFileType} result; unknown
 * types render as escaped plain text. Used by Read/Write tool displays.
 */
export function CodeBlock({
  code,
  fileType,
  className,
}: {
  code: string;
  fileType: string;
  className?: string;
}) {
  const html = useMemo(() => highlightCode(code, fileType), [code, fileType]);

  return (
    <pre
      className={cn(
        'hljs bg-muted rounded p-2 overflow-auto max-h-96 text-xs leading-relaxed',
        className
      )}
    >
      <code
        className="whitespace-pre-wrap break-words"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}
