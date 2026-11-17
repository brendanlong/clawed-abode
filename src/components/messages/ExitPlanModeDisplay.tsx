'use client';

import { z } from 'zod';
import { useState } from 'react';
import { ClipboardList } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ColorBadge } from './ColorBadge';
import { CopyButton } from './CopyButton';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { MarkdownContent } from '@/components/MarkdownContent';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { useMessageListActions, useMessageListTranscript } from './MessageListContext';
import { lenient, lenientString, parseToolInput } from './tool-input';
import type { ToolCall } from './types';

const exitPlanModeInputSchema = z.object({
  allowedPrompts: lenient(z.array(z.object({ tool: lenientString, prompt: lenientString }))),
  pushToRemote: lenient(z.boolean()),
  remoteSessionTitle: lenient(z.string()),
  remoteSessionUrl: lenient(z.string()),
});

/**
 * Specialized display for ExitPlanMode tool calls.
 * Shows the full rendered plan content and approval status.
 */
export function ExitPlanModeDisplay({ tool }: { tool: ToolCall }) {
  const onRespondToPlan = useMessageListActions()?.onRespondToPlan;
  const transcript = useMessageListTranscript();
  const hasOutput = tool.result !== undefined;
  const isPending = !hasOutput;
  const toolUseId = tool.id;
  const planContent = toolUseId ? transcript?.planContentByToolUseId.get(toolUseId) : undefined;
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  // Interactivity is driven purely by whether this plan still needs a response.
  // The server decides how to deliver it (resolve the live tool call or resume
  // as a new turn), so the UI doesn't track whether Claude is "running".
  const canRespond = isPending && !!onRespondToPlan && !!toolUseId;

  const inputObj = parseToolInput(tool.input, exitPlanModeInputSchema);
  const allowedPrompts = inputObj?.allowedPrompts ?? [];

  const handleApprove = () => {
    if (onRespondToPlan && toolUseId) onRespondToPlan(toolUseId, true);
  };

  const handleRequestChanges = () => {
    if (onRespondToPlan && toolUseId)
      onRespondToPlan(toolUseId, false, feedback.trim() || undefined);
  };

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<ClipboardList className="w-4 h-4 text-purple-600 dark:text-purple-400 shrink-0" />}
      title="Plan Complete"
      defaultExpanded={true}
      pendingText="Awaiting approval..."
      cardClassName="border-purple-300 dark:border-purple-700"
      subtitle={
        <div className="text-muted-foreground text-xs mt-1">
          Claude has finished planning and is ready for your review
        </div>
      }
      doneBadge={<ColorBadge color="purple">Ready for review</ColorBadge>}
    >
      {/* Full plan content rendered as Markdown */}
      {planContent && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="text-muted-foreground font-medium">Plan:</div>
            <CopyButton getText={() => planContent} />
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

      {/* Approve / request-changes controls */}
      {canRespond && (
        <div className="pt-3 mt-1 border-t space-y-2">
          {showFeedback && (
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should change about the plan? (optional)"
              className="min-h-[72px] text-sm"
              autoFocus
            />
          )}
          <div className="flex gap-2">
            {showFeedback ? (
              <>
                <Button size="sm" onClick={handleRequestChanges}>
                  Send changes
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setShowFeedback(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" onClick={handleApprove}>
                  Approve &amp; proceed
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowFeedback(true)}>
                  Request changes
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
