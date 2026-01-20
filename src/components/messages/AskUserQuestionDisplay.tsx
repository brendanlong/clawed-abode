'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import type { ToolCall } from './types';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskUserQuestionInput {
  questions: Question[];
}

// Question mark icon
function QuestionIcon() {
  return (
    <svg
      className="w-5 h-5 text-purple-600 dark:text-purple-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

// Checkbox icon for multi-select options
function CheckboxIcon({ checked }: { checked?: boolean }) {
  return (
    <svg
      className={cn(
        'w-4 h-4 flex-shrink-0',
        checked ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'
      )}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      {checked ? (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      ) : (
        <circle cx="12" cy="12" r="9" />
      )}
    </svg>
  );
}

// Radio icon for single-select options
function RadioIcon({ selected }: { selected?: boolean }) {
  return (
    <svg
      className={cn(
        'w-4 h-4 flex-shrink-0',
        selected ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'
      )}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" />
      {selected && <circle cx="12" cy="12" r="4" fill="currentColor" />}
    </svg>
  );
}

/**
 * Specialized display for AskUserQuestion tool calls.
 * Shows a nicely formatted question with options for the user to consider.
 */
export function AskUserQuestionDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(true);
  const hasOutput = tool.output !== undefined;
  const isPending = !hasOutput;
  const isError = tool.is_error;

  const questions = useMemo(() => {
    const inputObj = tool.input as AskUserQuestionInput | undefined;
    return inputObj?.questions ?? [];
  }, [tool.input]);

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card
          className={cn(
            'mt-2',
            isPending &&
              'border-purple-300 dark:border-purple-700 bg-purple-50/50 dark:bg-purple-950/30',
            isError && 'border-red-300 dark:border-red-700',
            !isPending && !isError && 'border-green-300 dark:border-green-700'
          )}
        >
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <QuestionIcon />
              <span className="font-mono text-primary">AskUserQuestion</span>
              {isPending && (
                <Badge
                  variant="outline"
                  className="text-xs border-purple-500 text-purple-700 dark:text-purple-400 animate-pulse"
                >
                  Waiting for input
                </Badge>
              )}
              {isError && (
                <Badge variant="destructive" className="text-xs">
                  Error
                </Badge>
              )}
              {!isPending && !isError && (
                <Badge
                  variant="outline"
                  className="text-xs border-green-500 text-green-700 dark:text-green-400"
                >
                  Answered
                </Badge>
              )}
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-4">
              {questions.map((question, qIndex) => (
                <div key={qIndex} className="space-y-2">
                  {/* Question header badge */}
                  {question.header && (
                    <Badge variant="secondary" className="text-xs">
                      {question.header}
                    </Badge>
                  )}

                  {/* Question text */}
                  <p className="text-sm font-medium text-foreground">{question.question}</p>

                  {/* Options */}
                  <div className="space-y-1.5 ml-1">
                    {question.options.map((option, oIndex) => (
                      <div
                        key={oIndex}
                        className={cn(
                          'flex items-start gap-2 py-1.5 px-2 rounded text-sm',
                          'bg-muted/50 hover:bg-muted transition-colors'
                        )}
                      >
                        {question.multiSelect ? <CheckboxIcon /> : <RadioIcon />}
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-foreground">{option.label}</div>
                          {option.description && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {option.description}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Show the response if answered */}
              {hasOutput && (
                <div className="pt-2 border-t">
                  <div className="text-xs text-muted-foreground mb-1">Response:</div>
                  <pre
                    className={cn(
                      'text-xs p-2 rounded overflow-x-auto',
                      isError
                        ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                        : 'bg-muted'
                    )}
                  >
                    {typeof tool.output === 'string'
                      ? tool.output
                      : JSON.stringify(tool.output, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
