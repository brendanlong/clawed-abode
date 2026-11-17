'use client';

import { Globe } from 'lucide-react';
import { z } from 'zod';
import { ColorBadge } from './ColorBadge';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { ToolOutputBlock } from './ToolOutputBlock';
import { lenient, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const webFetchInputSchema = z.object({ url: lenient(z.string()), prompt: lenient(z.string()) });

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
  const input = parseToolInput(tool.input, webFetchInputSchema);
  const url = input?.url ?? '';
  const prompt = input?.prompt ?? '';
  const hostname = getHostname(url);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<Globe className="w-4 h-4 text-cyan-600 dark:text-cyan-400 shrink-0" />}
      title="WebFetch"
      pendingText="Fetching..."
      headerContent={<span className="text-muted-foreground text-xs truncate">{hostname}</span>}
      subtitle={<div className="text-muted-foreground text-xs mt-1 truncate">{prompt}</div>}
      doneBadge={<ColorBadge color="cyan">Done</ColorBadge>}
    >
      {(output) => (
        <>
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

          <ToolOutputBlock
            label="Prompt:"
            output={prompt}
            maxHeight="max-h-24"
            wrap
            preClassName="text-xs"
          />

          {output.text !== undefined && (
            <div>
              <div className="text-muted-foreground mb-1">Response:</div>
              {output.isError ? (
                <ToolOutputBlock output={output.text} isError wrap />
              ) : (
                <div className="bg-muted rounded p-3 max-h-96 overflow-y-auto prose prose-sm dark:prose-invert max-w-none">
                  <MarkdownContent content={output.text ?? ''} />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </ToolDisplayWrapper>
  );
}
