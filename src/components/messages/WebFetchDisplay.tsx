'use client';

import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import type { ToolCall } from './types';

interface WebFetchInput {
  url: string;
  prompt: string;
}

function GlobeIcon() {
  return (
    <svg
      className="w-4 h-4 text-cyan-600 dark:text-cyan-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418"
      />
    </svg>
  );
}

/**
 * Extract hostname from a URL for display.
 */
function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Specialized display for WebFetch tool calls.
 * Shows the URL, prompt, and formatted response.
 */
export function WebFetchDisplay({ tool }: { tool: ToolCall }) {
  const hasOutput = tool.output !== undefined;

  const input = tool.input as WebFetchInput | undefined;
  const url = input?.url ?? '';
  const prompt = input?.prompt ?? '';
  const hostname = getHostname(url);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<GlobeIcon />}
      title="WebFetch"
      pendingText="Fetching..."
      headerContent={<span className="text-muted-foreground text-xs truncate">{hostname}</span>}
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{prompt}</div>}
      doneBadge={
        <Badge
          variant="outline"
          className="text-xs border-cyan-500 text-cyan-700 dark:text-cyan-400"
        >
          Done
        </Badge>
      }
    >
      {/* URL section */}
      <div>
        <div className="text-muted-foreground mb-1">URL:</div>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 dark:text-blue-400 hover:underline break-all text-sm"
        >
          {url}
        </a>
      </div>

      {/* Prompt section */}
      <div>
        <div className="text-muted-foreground mb-1">Prompt:</div>
        <pre className="bg-muted p-2 rounded overflow-x-auto max-h-24 overflow-y-auto whitespace-pre-wrap text-xs">
          {prompt}
        </pre>
      </div>

      {/* Output section */}
      {hasOutput && (
        <div>
          <div className="text-muted-foreground mb-1">Response:</div>
          {tool.is_error ? (
            <pre className="bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200 p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap break-words">
              {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
            </pre>
          ) : typeof tool.output === 'string' ? (
            <div className="bg-muted rounded p-3 max-h-96 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
              <MarkdownContent content={tool.output} />
            </div>
          ) : (
            <pre className="bg-muted p-2 rounded overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap text-xs">
              {JSON.stringify(tool.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
