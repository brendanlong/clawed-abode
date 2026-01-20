'use client';

import { useMemo } from 'react';
import { marked } from 'marked';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Configure marked options
marked.setOptions({
  gfm: true, // GitHub Flavored Markdown
  breaks: true, // Convert \n to <br>
});

export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  const html = useMemo(() => {
    try {
      const result = marked.parse(content);
      // marked.parse can return string or Promise<string>, but with sync options it returns string
      return typeof result === 'string' ? result : '';
    } catch {
      // Fallback to plain text if parsing fails
      return content;
    }
  }, [content]);

  return (
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
