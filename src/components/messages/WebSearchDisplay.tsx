'use client';

import { ExternalLink, Search } from 'lucide-react';
import { z } from 'zod';
import { ColorBadge } from './ColorBadge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';
import { parseWebSearchOutput } from '@/lib/web-search-output';

const webSearchInputSchema = z.object({ query: lenient(z.string()) });

/**
 * Specialized display for WebSearch tool calls.
 * Shows the search query, clickable source links, and a formatted summary.
 */
export function WebSearchDisplay({ tool }: { tool: ToolCall }) {
  const inputObj = parseToolInput(tool.input, webSearchInputSchema);
  const query = inputObj?.query ?? '';

  const sources = tool.result?.summary.webSearchSources ?? null;

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<Search className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />}
      title="WebSearch"
      pendingText="Searching..."
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{query}</div>}
      doneBadge={
        sources === null ? null : (
          <ColorBadge color="blue">
            {sources} {sources === 1 ? 'source' : 'sources'}
          </ColorBadge>
        )
      }
    >
      {(output) => {
        const parsed = parseWebSearchOutput(output.text ?? '');
        return (
          <>
            <div>
              <div className="text-muted-foreground text-xs mb-1">Query:</div>
              <code className="bg-muted px-2 py-1 rounded text-sm">{query}</code>
            </div>

            {output.isError && output.text !== undefined && (
              <ToolOutputBlock
                label="Error:"
                labelClassName="text-xs"
                output={output.text}
                isError
                maxHeight="max-h-48"
                preClassName="text-xs"
              />
            )}

            {output.text !== undefined && !output.isError && parsed && parsed.links.length > 0 && (
              <div>
                <div className="text-muted-foreground text-xs mb-1">Sources:</div>
                <div className="bg-muted rounded p-2 max-h-48 overflow-y-auto space-y-1">
                  {parsed.links.map((link, index) => (
                    <a
                      key={index}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group/link flex items-start gap-2 py-1.5 px-2 -mx-2 hover:bg-background/50 rounded text-xs"
                    >
                      <span className="text-muted-foreground shrink-0 mt-0.5">{index + 1}.</span>
                      <div className="flex-1 min-w-0">
                        <div className="text-blue-600 dark:text-blue-400 hover:underline font-medium truncate">
                          {link.title}
                        </div>
                        <div className="text-muted-foreground truncate text-xs">{link.url}</div>
                      </div>
                      <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0 opacity-0 group-hover/link:opacity-100 transition-opacity" />
                    </a>
                  ))}
                </div>
              </div>
            )}

            {output.text !== undefined && !output.isError && parsed && parsed.summary && (
              <div>
                <div className="text-muted-foreground text-xs mb-1">Summary:</div>
                <div className="bg-muted rounded p-3 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap">
                  {parsed.summary}
                </div>
              </div>
            )}

            {/* Fallback if parsing failed */}
            {output.text !== undefined && !output.isError && !parsed && (
              <ToolOutputBlock
                label="Result:"
                labelClassName="text-xs"
                output={output.text}
                maxHeight="max-h-48"
                preClassName="text-xs font-mono"
              />
            )}
          </>
        );
      }}
    </ToolDisplayWrapper>
  );
}
