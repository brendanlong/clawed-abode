'use client';

import { useMemo } from 'react';
import { displayMarkdown } from '@/lib/markdown';
import { sanitizeHtml } from '@/lib/sanitize-html';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  const html = useMemo(() => {
    try {
      return sanitizeHtml(displayMarkdown.parse(content, { async: false }));
    } catch {
      // Fallback to sanitized plain text if parsing fails
      return sanitizeHtml(content);
    }
  }, [content]);

  return (
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
