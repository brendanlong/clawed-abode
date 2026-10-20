'use client';

import { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { OctagonX, Loader2 } from 'lucide-react';

import { CopyButton } from './CopyButton';
import { SanitizationBadge } from './SanitizationBadge';
import { MessageTimestamp } from './MessageTimestamp';
import { renderContent } from './ContentRenderer';
import { useMessageListContext } from './MessageListContext';
import { parseSanitizationInfo } from '@/lib/sanitization';
import { MessagePlayButton } from '@/components/voice/MessagePlayButton';
import { extractAssistantText } from '@/components/voice/playable-messages';
import { useVoicePlaybackContext } from '@/hooks/useVoicePlayback';
import {
  buildToolCalls,
  getCopyText,
  getDisplayContent,
  hasElidedResults,
  loadToolResultTexts,
  type MessageCategory,
} from './messageHelpers';
import type { MessageContent, ToolCall, ToolResultMap } from './types';

interface MainMessageBubbleProps {
  messageId?: string;
  content: MessageContent;
  category: MessageCategory;
  isPartial: boolean;
  toolResults?: ToolResultMap;
  createdAt?: Date;
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
  createdAt,
}: MainMessageBubbleProps) {
  const isUser = category === 'user';
  const isAssistant = category === 'assistant';
  const isError = category === 'systemError';
  const isInterrupted = content.interrupted === true;

  const toolCalls = useMemo((): ToolCall[] => {
    if (!isAssistant) return [];
    return buildToolCalls(content, toolResults);
  }, [isAssistant, content, toolResults]);

  // Copying includes every tool output, so outputs not yet loaded are fetched first.
  const loadToolResultText = useMessageListContext()?.loadToolResultText;
  const handleGetCopyText = useCallback(() => {
    if (!loadToolResultText || !hasElidedResults(toolCalls)) {
      return getCopyText(content, category, toolCalls);
    }
    return loadToolResultTexts(toolCalls, loadToolResultText).then((loaded) =>
      getCopyText(content, category, loaded)
    );
  }, [content, category, toolCalls, loadToolResultText]);

  const displayContent = getDisplayContent(content, category);

  // Sanitizer findings persisted on a user prompt whose text was filtered.
  const sanitization = useMemo(
    () => (isUser ? parseSanitizationInfo(content.sanitization) : null),
    [isUser, content.sanitization]
  );

  // Voice playback: show play button on completed assistant messages with text
  const playback = useVoicePlaybackContext();
  const textForPlayback = useMemo(() => {
    if (!isAssistant || isPartial || !messageId || !playback.enabled) return null;
    return extractAssistantText(content);
  }, [isAssistant, isPartial, messageId, playback.enabled, content]);

  return (
    <div className="max-w-[85%]">
      <div
        className={cn('rounded-lg p-4', {
          'bg-primary text-primary-foreground ml-auto': isUser,
          'bg-card border': isAssistant && !isInterrupted && !isPartial,
          'bg-card border border-blue-300 dark:border-blue-700': isAssistant && isPartial,
          'bg-card border border-amber-300 dark:border-amber-700':
            isAssistant && isInterrupted && !isPartial,
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

        {sanitization && (
          <div className="mt-2">
            <SanitizationBadge info={sanitization} surface="message" />
          </div>
        )}
      </div>
      {!isPartial && (
        <div className={cn('mt-1 flex items-center gap-1', isUser && 'justify-end')}>
          <CopyButton getText={handleGetCopyText} />
          {textForPlayback && messageId && (
            <MessagePlayButton
              messageId={messageId}
              text={textForPlayback}
              className="h-6 px-2 text-xs"
            />
          )}
          {isUser && <MessageTimestamp createdAt={createdAt} />}
        </div>
      )}
    </div>
  );
}
