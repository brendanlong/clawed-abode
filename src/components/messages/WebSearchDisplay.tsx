'use client';

import { z } from 'zod';
import { ColorBadge } from './ColorBadge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';
import { parseWebSearchOutput } from '@/lib/web-search-output';

const webSearchInputSchema = z.object({ query: lenient(z.string()) });

const SearchIcon = () => (
  <svg
    className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={1.5}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
    />
  </svg>
);

const ExternalLinkIcon = () => (
  <svg
    className="w-3 h-3 text-muted-foreground shrink-0 opacity-0 group-hover/link:opacity-100 transition-opacity"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
    />
  </svg>
);

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
      icon={<SearchIcon />}
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
                      <ExternalLinkIcon />
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
