'use client';

import { useMemo } from 'react';
import { marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Configure marked options
marked.setOptions({
  gfm: true, // GitHub Flavored Markdown
  breaks: true, // Convert \n to <br>
});

// Open links in a new window. A sanitizer hook rather than a marked renderer
// override, because a renderer has to assemble the anchor as an HTML string —
// which means hand-escaping href/title and skipping marked's own URL
// sanitization. See doc/security.md. The hook is global to the shared DOMPurify
// instance; that's fine, since it only touches anchors and `noopener` is wanted
// wherever one shows up.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
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
      return DOMPurify.sanitize(rawHtml);
    } catch {
      // Fallback to sanitized plain text if parsing fails
      return DOMPurify.sanitize(content);
    }
  }, [content]);

  return (
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
