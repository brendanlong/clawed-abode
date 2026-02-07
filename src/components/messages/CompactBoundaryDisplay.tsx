'use client';

import { useCallback } from 'react';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from './CopyButton';
import { formatAsJson } from './types';
import type { MessageContent } from './types';

interface CompactBoundaryContent extends MessageContent {
  compact_metadata?: {
    trigger: 'manual' | 'auto';
    pre_tokens: number;
  };
}

/**
 * Display for compact_boundary system messages.
 * Shows when conversation context was compacted (auto or manual).
 */
export function CompactBoundaryDisplay({ content }: { content: CompactBoundaryContent }) {
  const getJsonText = useCallback(() => formatAsJson(content), [content]);

  const trigger = content.compact_metadata?.trigger ?? 'auto';
  const preTokens = content.compact_metadata?.pre_tokens;

  const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
    return tokens.toString();
  };

  return (
    <div className="group">
      <div className="flex items-center gap-2 text-sm p-2">
        <div className="flex-1 border-t border-dashed border-border" />
        <Badge variant="secondary" className="flex-shrink-0">
          Context Compacted
        </Badge>
        <span className="text-muted-foreground text-xs flex-shrink-0">
          {trigger === 'manual' ? 'manual' : 'auto'}
          {preTokens !== undefined && ` · ${formatTokens(preTokens)} tokens before`}
        </span>
        <div className="flex-1 border-t border-dashed border-border" />
      </div>
      <div className="mt-1">
        <CopyButton getText={getJsonText} />
      </div>
    </div>
  );
}
