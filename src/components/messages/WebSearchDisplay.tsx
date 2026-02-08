'use client';

import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

interface WebSearchInput {
  query: string;
}

interface SearchLink {
  title: string;
  url: string;
}

interface ParsedWebSearchOutput {
  query: string;
  links: SearchLink[];
  summary: string;
}

/**
 * Parse WebSearch output into structured components.
 * The output format is:
 * - First line: "Web search results for query: \"...\""
 * - Links line: "Links: [{...}, ...]"
 * - Rest: Summary text
 */
function parseWebSearchOutput(output: string): ParsedWebSearchOutput | null {
  if (!output || typeof output !== 'string') {
    return null;
  }

  const result: ParsedWebSearchOutput = {
    query: '',
    links: [],
    summary: '',
  };

  // Split by newlines and process
  const lines = output.split('\n');
  let summaryStartIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse query from first line
    const queryMatch = line.match(/^Web search results for query: "(.+)"$/);
    if (queryMatch) {
      result.query = queryMatch[1];
      summaryStartIndex = i + 1;
      continue;
    }

    // Parse links JSON
    if (line.startsWith('Links: ')) {
      try {
        const jsonStr = line.substring('Links: '.length);
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          result.links = parsed.filter(
            (item): item is SearchLink =>
              typeof item === 'object' &&
              item !== null &&
              typeof item.title === 'string' &&
              typeof item.url === 'string'
          );
        }
      } catch {
        // If parsing fails, just skip the links
      }
      summaryStartIndex = i + 1;
      continue;
    }
  }

  // Everything after the links line is the summary
  const summaryLines = lines.slice(summaryStartIndex);
  result.summary = summaryLines.join('\n').trim();

  return result;
}

// Search/globe icon component
const SearchIcon = () => (
  <svg
    className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0"
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

// External link icon component
const ExternalLinkIcon = () => (
  <svg
    className="w-3 h-3 text-muted-foreground flex-shrink-0 opacity-0 group-hover/link:opacity-100 transition-opacity"
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
  const hasOutput = tool.output !== undefined;

  const inputObj = tool.input as WebSearchInput | undefined;
  const query = inputObj?.query ?? '';

  const parsed = useMemo(() => {
    if (typeof tool.output !== 'string') {
      return null;
    }
    return parseWebSearchOutput(tool.output);
  }, [tool.output]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<SearchIcon />}
      title="WebSearch"
      pendingText="Searching..."
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{query}</div>}
      doneBadge={
        parsed ? (
          <Badge
            variant="outline"
            className="text-xs border-blue-500 text-blue-700 dark:text-blue-400"
          >
            {parsed.links.length} {parsed.links.length === 1 ? 'source' : 'sources'}
          </Badge>
        ) : null
      }
    >
      {/* Query section */}
      <div>
        <div className="text-muted-foreground text-xs mb-1">Query:</div>
        <code className="bg-muted px-2 py-1 rounded text-sm">{query}</code>
      </div>

      {/* Error display */}
      {tool.is_error && hasOutput && (
        <div>
          <div className="text-muted-foreground text-xs mb-1">Error:</div>
          <pre className="bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto text-xs">
            {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
          </pre>
        </div>
      )}

      {/* Sources section */}
      {hasOutput && !tool.is_error && parsed && parsed.links.length > 0 && (
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
                <span className="text-muted-foreground flex-shrink-0 mt-0.5">{index + 1}.</span>
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

      {/* Summary section */}
      {hasOutput && !tool.is_error && parsed && parsed.summary && (
        <div>
          <div className="text-muted-foreground text-xs mb-1">Summary:</div>
          <div className="bg-muted rounded p-3 max-h-64 overflow-y-auto text-sm whitespace-pre-wrap">
            {parsed.summary}
          </div>
        </div>
      )}

      {/* Fallback if parsing failed */}
      {hasOutput && !tool.is_error && !parsed && (
        <div>
          <div className="text-muted-foreground text-xs mb-1">Result:</div>
          <pre className="bg-muted p-2 rounded overflow-x-auto max-h-48 overflow-y-auto text-xs font-mono">
            {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
          </pre>
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
