'use client';

import { memo, useMemo } from 'react';
import { OctagonX } from 'lucide-react';

import { RawJsonDisplay } from './RawJsonDisplay';
import { ResultDisplay } from './ResultDisplay';
import { CompactBoundaryDisplay } from './CompactBoundaryDisplay';
import { RefusalFallbackDisplay } from './RefusalFallbackDisplay';
import { InjectedMessageDisplay } from './InjectedMessageDisplay';
import { TaskNotificationDisplay } from './TaskNotificationDisplay';
import { MainMessageBubble } from './MainMessageBubble';
import { MessageTimestamp } from './MessageTimestamp';
import { isRecognizedMessage, messageBubblePropsEqual } from './messageHelpers';
import { isTranscriptRow } from '@/lib/transcript-display';
import { isPartialMessageId } from '@/lib/message-cache';
import type { MessageBubbleProps, MessageContent } from './types';

/**
 * One transcript message. Memoized on its own fields and its own calls' results
 * (see `messageBubblePropsEqual`), so a transcript update re-renders only the
 * bubbles it touches.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  toolResults,
}: MessageBubbleProps) {
  const { type } = message;
  const content = useMemo(() => (message.content || {}) as MessageContent, [message.content]);

  const isPartial = useMemo(() => {
    return content.partial === true || (message.id ? isPartialMessageId(message.id) : false);
  }, [content.partial, message.id]);

  const recognition = useMemo(() => isRecognizedMessage(type, content), [type, content]);
  const category = recognition.recognized ? recognition.category : null;

  // Lists filter with the same predicate (so no empty spacer row is left); this
  // keeps a bubble handed anything else from rendering an empty shell.
  if (!isTranscriptRow(type, content)) {
    return null;
  }

  if (!recognition.recognized) {
    return (
      <div className="w-full max-w-[85%]">
        <RawJsonDisplay content={message.content} label={`Unknown: ${type}`} />
      </div>
    );
  }

  if (category === 'systemCompactBoundary') {
    return (
      <div className="w-full">
        <CompactBoundaryDisplay content={content} />
      </div>
    );
  }

  if (category === 'systemRefusalFallback') {
    return (
      <div className="w-full max-w-[85%]">
        <RefusalFallbackDisplay messageId={message.id} content={content} />
      </div>
    );
  }

  if (category === 'result') {
    return (
      <div className="w-full max-w-[85%]">
        <ResultDisplay content={content as Record<string, unknown>} createdAt={message.createdAt} />
      </div>
    );
  }

  if (category === 'injectedMessage') {
    return (
      <div className="w-full max-w-[85%]">
        <InjectedMessageDisplay content={content} createdAt={message.createdAt} />
      </div>
    );
  }

  if (category === 'taskNotification') {
    return (
      <div className="w-full max-w-[85%]">
        <TaskNotificationDisplay content={content} />
      </div>
    );
  }

  if (category === 'userInterrupt') {
    return (
      <div className="w-full max-w-[85%] ml-auto">
        <div className="flex items-center gap-2 justify-end text-muted-foreground text-sm py-2">
          <OctagonX className="h-4 w-4" />
          <span>Interrupted</span>
          <MessageTimestamp createdAt={message.createdAt} />
        </div>
      </div>
    );
  }

  return (
    <MainMessageBubble
      messageId={message.id}
      content={content}
      category={category!}
      isPartial={isPartial}
      toolResults={toolResults}
      createdAt={message.createdAt}
    />
  );
}, messageBubblePropsEqual);
