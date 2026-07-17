'use client';

import { useMemo } from 'react';
import { marked, Renderer, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Create custom renderer that opens links in new windows
const renderer = new Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

// Configure marked options
marked.setOptions({
  gfm: true, // GitHub Flavored Markdown
  breaks: true, // Convert \n to <br>
  renderer,
});

// Only allow double-tilde strikethrough (`~~text~~`). Claude uses a single `~`
// to mean "approximately" (e.g. `~5 minutes`) far more often than for
// strikethrough, so override the `del` inline tokenizer to match `~~…~~` only
// and leave single tildes as literal text.
marked.use({
  tokenizer: {
    del(src: string): Tokens.Del | undefined {
      const match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src);
      if (!match) return undefined;
      return {
        type: 'del',
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
  },
});

export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  const html = useMemo(() => {
    try {
      const result = marked.parse(content);
      // marked.parse can return string or Promise<string>, but with sync options it returns string
      const rawHtml = typeof result === 'string' ? result : '';
      // Sanitize HTML to prevent XSS attacks
      // Allow target attribute on links so they open in new windows
      return DOMPurify.sanitize(rawHtml, {
        ADD_ATTR: ['target'],
      });
    } catch {
      // Fallback to sanitized plain text if parsing fails
      return DOMPurify.sanitize(content, {
        ADD_ATTR: ['target'],
      });
    }
  }, [content]);

  return (
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
