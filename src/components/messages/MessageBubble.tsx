'use client';

import { useMemo } from 'react';
import { OctagonX } from 'lucide-react';

import { RawJsonDisplay } from './RawJsonDisplay';
import { ToolResultDisplay } from './ToolResultDisplay';
import { SystemInitDisplay } from './SystemInitDisplay';
import { ResultDisplay } from './ResultDisplay';
import { HookResponseDisplay } from './HookResponseDisplay';
import { HookStartedDisplay } from './HookStartedDisplay';
import { CompactBoundaryDisplay } from './CompactBoundaryDisplay';
import { MainMessageBubble } from './MainMessageBubble';
import { isRecognizedMessage, getToolResults } from './messageHelpers';
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

  if (!recognition.recognized) {
    return (
      <div className="w-full max-w-[85%]">
        <RawJsonDisplay content={message.content} label={`Unknown: ${type}`} />
      </div>
    );
  }

  if (category === 'systemInit') {
    return (
      <div className="w-full max-w-[85%]">
        <SystemInitDisplay content={content} />
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

  if (category === 'hookStarted') {
    return (
      <div className="w-full max-w-[85%]">
        <HookStartedDisplay content={content} />
      </div>
    );
  }

  if (category === 'hookResponse') {
    return (
      <div className="w-full max-w-[85%]">
        <HookResponseDisplay content={content} />
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
