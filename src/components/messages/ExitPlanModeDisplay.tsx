'use client';

import { useCallback, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { useMessageListContext } from './MessageListContext';
import type { ToolCall } from './types';

interface ExitPlanModeInput {
  allowedPrompts?: Array<{
    tool: string;
    prompt: string;
  }>;
  pushToRemote?: boolean;
  remoteSessionId?: string;
  remoteSessionTitle?: string;
  remoteSessionUrl?: string;
}

// Clipboard/plan icon component
function ClipboardIcon() {
  return (
    <svg
      className="w-4 h-4 text-purple-600 dark:text-purple-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z"
      />
    </svg>
  );
}

// Copy icon
function CopyIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184"
      />
    </svg>
  );
}

// Check icon
function CheckIcon() {
  return (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
    </svg>
  );
}

/**
 * Specialized display for ExitPlanMode tool calls.
 * Shows the full rendered plan content and approval status.
 */
export function ExitPlanModeDisplay({ tool }: { tool: ToolCall }) {
  const ctx = useMessageListContext();
  const planContent = ctx?.latestPlanContent;
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;
  const [copied, setCopied] = useState(false);

  const inputObj = tool.input as ExitPlanModeInput | undefined;
  const allowedPrompts = inputObj?.allowedPrompts ?? [];

  const handleCopyPlan = useCallback(async () => {
    if (!planContent) return;
    try {
      await navigator.clipboard.writeText(planContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
    }
  }, [planContent]);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<ClipboardIcon />}
      title="Plan Complete"
      defaultExpanded={true}
      pendingText="Awaiting approval..."
      cardClassName="border-purple-300 dark:border-purple-700"
      subtitle={
        <div className="text-muted-foreground text-xs mt-1">
          Claude has finished planning and is ready for your review
        </div>
      }
      doneBadge={
        <Badge
          variant="outline"
          className="text-xs border-purple-500 text-purple-700 dark:text-purple-400"
        >
          Ready for review
        </Badge>
      }
    >
      {/* Full plan content rendered as Markdown */}
      {planContent && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-muted-foreground font-medium">Plan:</div>
            <button
              type="button"
              onClick={handleCopyPlan}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Copy plan to clipboard"
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="bg-muted/50 rounded p-3 overflow-y-auto max-h-[600px]">
            <MarkdownContent content={planContent} />
          </div>
        </div>
      )}

      {/* Allowed prompts section */}
      {allowedPrompts.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1">Requested permissions:</div>
          <ul className="bg-muted rounded p-2 space-y-1">
            {allowedPrompts.map((prompt, index) => (
              <li key={index} className="flex items-center gap-2">
                <Badge variant="outline" className="text-xs">
                  {prompt.tool}
                </Badge>
                <span>{prompt.prompt}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Remote session info */}
      {inputObj?.pushToRemote && inputObj.remoteSessionUrl && (
        <div>
          <div className="text-muted-foreground mb-1">Remote session:</div>
          <a
            href={inputObj.remoteSessionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            {inputObj.remoteSessionTitle || inputObj.remoteSessionUrl}
          </a>
        </div>
      )}

      {/* Show status message if no plan content available */}
      {!planContent && isPending && (
        <div className="text-muted-foreground italic py-2">Waiting for plan approval...</div>
      )}
    </ToolDisplayWrapper>
  );
}
