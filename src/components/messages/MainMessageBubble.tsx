'use client';

import { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { OctagonX, Loader2 } from 'lucide-react';

import { CopyButton } from './CopyButton';
import { ToolCallDisplay } from './ToolCallDisplay';
import { renderContent } from './ContentRenderer';
import { MessagePlayButton } from '@/components/voice/MessagePlayButton';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';
import {
  buildToolCalls,
  getCopyText,
  getDisplayContent,
  type MessageCategory,
} from './messageHelpers';
import type { MessageContent, ToolCall, ToolResultMap } from './types';

interface MainMessageBubbleProps {
  messageId?: string;
  content: MessageContent;
  category: MessageCategory;
  isPartial: boolean;
  toolResults?: ToolResultMap;
}

/**
 * Renders the main styled message bubble for assistant, user, system, and error messages.
 * Handles styling, status indicators, content rendering, and copy functionality.
 */
export function MainMessageBubble({
  messageId,
  content,
  category,
  isPartial,
  toolResults,
}: MainMessageBubbleProps) {
  const isUser = category === 'user';
  const isAssistant = category === 'assistant';
  const isSystem = category === 'system';
  const isError = category === 'systemError';
  const isInterrupted = content.interrupted === true;

  const toolCalls = useMemo((): ToolCall[] => {
    if (!isAssistant) return [];
    return buildToolCalls(content, toolResults);
  }, [isAssistant, content, toolResults]);

  const handleGetCopyText = useCallback(() => {
    return getCopyText(content, category, toolCalls);
  }, [content, category, toolCalls]);

  const displayContent = getDisplayContent(content, category);

  // Voice playback: show play button on completed assistant messages with text
  const playback = useVoicePlaybackContext();
  const textForPlayback = useMemo(() => {
    if (!isAssistant || isPartial || !messageId || !playback.enabled) return null;
    const text = getCopyText(content, category, toolCalls);
    return text.trim().length > 0 ? text : null;
  }, [isAssistant, isPartial, messageId, playback.enabled, content, category, toolCalls]);

  return (
    <div className="group max-w-[85%]">
      <div
        className={cn('rounded-lg p-4', {
          'bg-primary text-primary-foreground ml-auto': isUser,
          'bg-card border': isAssistant && !isInterrupted && !isPartial,
          'bg-card border border-blue-300 dark:border-blue-700': isAssistant && isPartial,
          'bg-card border border-amber-300 dark:border-amber-700':
            isAssistant && isInterrupted && !isPartial,
          'bg-muted text-muted-foreground text-sm': isSystem && !isError,
          'bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-200 text-sm':
            isError,
        })}
      >
        {isPartial && isAssistant && (
          <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400 text-xs mb-2">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Streaming...</span>
          </div>
        )}
        {isSystem && !isError && (
          <Badge variant="secondary" className="mb-2">
            System
          </Badge>
        )}
        {isError && (
          <Badge variant="destructive" className="mb-2">
            Error
          </Badge>
        )}
        {isInterrupted && !isPartial && (
          <div className="flex items-center gap-1 text-amber-600 dark:text-amber-400 text-xs mb-2">
            <OctagonX className="h-3 w-3" />
            <span>May be incomplete</span>
          </div>
        )}

        {renderContent(displayContent, toolResults)}

        {content.tool_calls && content.tool_calls.length > 0 && (
          <div className="mt-2 space-y-2">
            {content.tool_calls.map((tool, index) => (
              <ToolCallDisplay key={index} tool={tool} />
            ))}
          </div>
        )}
      </div>
      {!isPartial && (
        <div className="mt-1 flex items-center gap-1">
          <CopyButton getText={handleGetCopyText} />
          {textForPlayback && messageId && (
            <MessagePlayButton
              messageId={messageId}
              text={textForPlayback}
              className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity"
            />
          )}
        </div>
      )}
    </div>
  );
}
