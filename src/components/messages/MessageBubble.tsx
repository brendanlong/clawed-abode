'use client';

import { useMemo } from 'react';
import { OctagonX } from 'lucide-react';

import { RawJsonDisplay } from './RawJsonDisplay';
import { ToolResultDisplay } from './ToolResultDisplay';
import { ResultDisplay } from './ResultDisplay';
import { CompactBoundaryDisplay } from './CompactBoundaryDisplay';
import { RefusalFallbackDisplay } from './RefusalFallbackDisplay';
import { MainMessageBubble } from './MainMessageBubble';
import {
  isRecognizedMessage,
  getToolResults,
  hasRenderableAssistantContent,
  isHiddenSystemMessage,
} from './messageHelpers';
import { isIgnoredSystemMessage } from '@/lib/claude-messages';
import type { ToolResultMap, MessageContent } from './types';

export function MessageBubble({
  message,
  toolResults,
}: {
  message: { id?: string; type: string; content: unknown };
  toolResults?: ToolResultMap;
}) {
  const { type } = message;
  const content = useMemo(() => (message.content || {}) as MessageContent, [message.content]);

  const isPartial = useMemo(() => {
    return content.partial === true || (message.id?.startsWith('partial-') ?? false);
  }, [content.partial, message.id]);

  const recognition = useMemo(() => isRecognizedMessage(type, content), [type, content]);
  const category = recognition.recognized ? recognition.category : null;

  // Ignored system events (transient progress / internal state) carry no durable
  // content. New ones are never persisted; this also hides any stored earlier.
  if (isIgnoredSystemMessage(content)) {
    return null;
  }

  // System messages are hidden from the transcript to reduce noise (issue #312).
  // Only errors and compact boundaries remain visible (see isHiddenSystemMessage).
  if (isHiddenSystemMessage(type, content)) {
    return null;
  }

  // Assistant fragments with nothing renderable (e.g. an empty thinking block
  // with only a continuity signature) would otherwise show as an empty bubble.
  if (category === 'assistant' && !hasRenderableAssistantContent(content)) {
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
        <RefusalFallbackDisplay content={content} />
      </div>
    );
  }

  if (category === 'result') {
    return (
      <div className="w-full max-w-[85%]">
        <ResultDisplay content={content as Record<string, unknown>} />
      </div>
    );
  }

  if (category === 'toolResult') {
    const toolResultBlocks = getToolResults(content);
    return (
      <div className="w-full max-w-[85%]">
        <ToolResultDisplay results={toolResultBlocks} />
      </div>
    );
  }

  if (category === 'userInterrupt') {
    return (
      <div className="w-full max-w-[85%] ml-auto">
        <div className="flex items-center gap-2 justify-end text-muted-foreground text-sm py-2">
          <OctagonX className="h-4 w-4" />
          <span>Interrupted</span>
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
    />
  );
}
