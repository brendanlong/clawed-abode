'use client';

import { useState, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { ToolDisplayWrapper } from './ToolDisplayWrapper';
import { useMessageListContext } from './MessageListContext';
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
        'w-4 h-4 flex-shrink-0 mt-0.5',
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
        'w-4 h-4 flex-shrink-0 mt-0.5',
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
 * Build the updatedInput for responding to an AskUserQuestion via canUseTool.
 * Format: { questions: [...], answers: { "question text": "selected label(s)" } }
 */
function buildAskUserQuestionResponse(
  questions: Question[],
  answers: Record<string, string>
): Record<string, unknown> {
  return {
    questions,
    answers,
  };
}

/**
 * Specialized display for AskUserQuestion tool calls.
 * Shows a nicely formatted question with clickable options.
 *
 * When a pendingInputRequest is available (canUseTool callback flow),
 * user responses are sent via onRespond with updatedInput containing
 * the questions and answers. Otherwise falls back to onSendResponse.
 *
 * When there are multiple questions, all selections are collected first
 * and sent together via a "Submit Answers" button.
 */
export function AskUserQuestionDisplay({ tool }: { tool: ToolCall }) {
  const ctx = useMessageListContext();
  const onSendResponse = ctx?.onSendResponse;
  const onRespond = ctx?.onRespond;
  const pendingInputRequest = ctx?.pendingInputRequest;
  const isClaudeRunning = ctx?.isClaudeRunning;

  // For multi-select questions: track toggled option indices per question
  const [multiSelectOptions, setMultiSelectOptions] = useState<Map<number, Set<number>>>(new Map());
  // For single-select questions: track the selected option index per question
  const [singleSelectOptions, setSingleSelectOptions] = useState<Map<number, number>>(new Map());

  const hasOutput = tool.output !== undefined;

  // Check if this tool call has a matching pending input request
  const hasPendingRequest = pendingInputRequest?.toolName === 'AskUserQuestion';

  // Check if this is a "real" error vs just waiting for input
  const isWaitingForInput =
    tool.is_error && typeof tool.output === 'string' && tool.output.includes('Answer questions');
  const isRealError = tool.is_error && !isWaitingForInput;
  const isPending = !hasOutput || isWaitingForInput;

  // The question is actionable if pending AND we have a way to respond
  const isActionable =
    isPending && !isClaudeRunning && (hasPendingRequest ? !!onRespond : !!onSendResponse);

  const questions = useMemo(() => {
    const inputObj = tool.input as AskUserQuestionInput | undefined;
    return inputObj?.questions ?? [];
  }, [tool.input]);

  const hasMultipleQuestions = questions.length > 1;

  /**
   * Send all answers back to Claude at once.
   */
  const sendAllAnswers = useCallback(
    (answers: Record<string, string>) => {
      if (hasPendingRequest && onRespond && pendingInputRequest) {
        onRespond({
          requestId: pendingInputRequest.requestId,
          behavior: 'allow',
          updatedInput: buildAskUserQuestionResponse(questions, answers),
        });
      } else if (onSendResponse) {
        // Legacy fallback: send the answer labels as a plain text response
        const answerValues = Object.values(answers);
        onSendResponse(answerValues.join(', '));
      }
    },
    [hasPendingRequest, onRespond, pendingInputRequest, onSendResponse, questions]
  );

  /**
   * Build the answers map from current selections across all questions.
   */
  const buildAnswersFromSelections = useCallback((): Record<string, string> => {
    const answers: Record<string, string> = {};
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const question = questions[qIdx];
      if (!question) continue;

      if (question.multiSelect) {
        const selected = multiSelectOptions.get(qIdx);
        if (selected && selected.size > 0) {
          const labels = Array.from(selected)
            .map((idx) => question.options[idx]?.label)
            .filter(Boolean);
          answers[question.question] = labels.join(', ');
        }
      } else {
        const selectedIdx = singleSelectOptions.get(qIdx);
        if (selectedIdx !== undefined) {
          const option = question.options[selectedIdx];
          if (option) {
            answers[question.question] = option.label;
          }
        }
      }
    }
    return answers;
  }, [questions, multiSelectOptions, singleSelectOptions]);

  /**
   * Check if all questions have at least one selection.
   */
  const allQuestionsAnswered = useMemo(() => {
    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const question = questions[qIdx];
      if (!question) return false;

      if (question.multiSelect) {
        const selected = multiSelectOptions.get(qIdx);
        if (!selected || selected.size === 0) return false;
      } else {
        if (!singleSelectOptions.has(qIdx)) return false;
      }
    }
    return questions.length > 0;
  }, [questions, multiSelectOptions, singleSelectOptions]);

  // Handle clicking an option
  const handleOptionClick = (questionIndex: number, optionIndex: number, multiSelect: boolean) => {
    if (!isActionable) return;

    const question = questions[questionIndex];
    if (!question) return;

    if (multiSelect) {
      // Toggle selection for multi-select
      setMultiSelectOptions((prev) => {
        const newMap = new Map(prev);
        const currentSet = newMap.get(questionIndex) ?? new Set();
        const newSet = new Set(currentSet);
        if (newSet.has(optionIndex)) {
          newSet.delete(optionIndex);
        } else {
          newSet.add(optionIndex);
        }
        newMap.set(questionIndex, newSet);
        return newMap;
      });
    } else if (hasMultipleQuestions) {
      // Multiple questions: just select, don't send yet
      setSingleSelectOptions((prev) => {
        const newMap = new Map(prev);
        newMap.set(questionIndex, optionIndex);
        return newMap;
      });
    } else {
      // Single question, single select: send immediately
      const option = question.options[optionIndex];
      if (option) {
        sendAllAnswers({ [question.question]: option.label });
      }
    }
  };

  // Handle the unified submit button
  const handleSubmitAll = () => {
    const answers = buildAnswersFromSelections();
    if (Object.keys(answers).length > 0) {
      sendAllAnswers(answers);
    }
  };

  // Check if an option is selected
  const isOptionSelected = (questionIndex: number, optionIndex: number, multiSelect: boolean) => {
    if (multiSelect) {
      return multiSelectOptions.get(questionIndex)?.has(optionIndex) ?? false;
    }
    return singleSelectOptions.get(questionIndex) === optionIndex;
  };

  // Check if an option was the answered option (match output with option label)
  const isAnsweredOption = (option: QuestionOption) => {
    if (isPending || !hasOutput || typeof tool.output !== 'string') return false;
    const output = tool.output.trim();
    return output === option.label || output.split(', ').includes(option.label);
  };

  // Determine whether to show the unified submit button:
  // Show when multiple questions exist and at least one has a selection,
  // OR when a single multi-select question has selections.
  const showSubmitButton =
    isActionable &&
    (hasMultipleQuestions
      ? singleSelectOptions.size > 0 ||
        Array.from(multiSelectOptions.values()).some((s) => s.size > 0)
      : questions.length === 1 &&
        questions[0]?.multiSelect &&
        (multiSelectOptions.get(0)?.size ?? 0) > 0);

  return (
    <ToolDisplayWrapper
      tool={tool}
      icon={<QuestionIcon />}
      title="AskUserQuestion"
      defaultExpanded={true}
      isPendingOverride={isPending}
      isErrorOverride={isRealError}
      pendingText="Waiting for input"
      cardClassName={cn(
        isPending &&
          'border-purple-300 dark:border-purple-700 bg-purple-50/50 dark:bg-purple-950/30',
        !isPending && !isRealError && 'border-green-300 dark:border-green-700'
      )}
      doneBadge={
        <Badge
          variant="outline"
          className="text-xs border-green-500 text-green-700 dark:text-green-400"
        >
          Answered
        </Badge>
      }
    >
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
            {question.options.map((option, oIndex) => {
              const isSelected = isOptionSelected(qIndex, oIndex, question.multiSelect);
              const wasAnswered = isAnsweredOption(option);

              return (
                <button
                  key={oIndex}
                  type="button"
                  disabled={!isActionable}
                  onClick={() => handleOptionClick(qIndex, oIndex, question.multiSelect)}
                  className={cn(
                    'flex items-start gap-2 py-1.5 px-2 rounded text-sm w-full text-left',
                    'transition-colors',
                    isActionable
                      ? 'bg-muted/50 hover:bg-purple-100 dark:hover:bg-purple-900/50 cursor-pointer'
                      : 'bg-muted/50',
                    isSelected && 'bg-purple-100 dark:bg-purple-900/50 ring-1 ring-purple-400',
                    wasAnswered && 'bg-green-100 dark:bg-green-900/50 ring-1 ring-green-400'
                  )}
                >
                  {question.multiSelect || hasMultipleQuestions ? (
                    question.multiSelect ? (
                      <CheckboxIcon checked={isSelected || wasAnswered} />
                    ) : (
                      <RadioIcon selected={isSelected || wasAnswered} />
                    )
                  ) : (
                    <RadioIcon selected={isSelected || wasAnswered} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-foreground">{option.label}</div>
                    {option.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {option.description}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* Unified submit button for multiple questions or multi-select */}
      {showSubmitButton && (
        <div className="pt-2 border-t">
          <button
            type="button"
            onClick={handleSubmitAll}
            disabled={hasMultipleQuestions && !allQuestionsAnswered}
            className={cn(
              'px-4 py-2 text-sm rounded transition-colors font-medium',
              hasMultipleQuestions && !allQuestionsAnswered
                ? 'bg-purple-400 text-white cursor-not-allowed opacity-60'
                : 'bg-purple-600 hover:bg-purple-700 text-white'
            )}
          >
            {hasMultipleQuestions ? 'Submit Answers' : 'Submit Selected'}
          </button>
          {hasMultipleQuestions && !allQuestionsAnswered && (
            <p className="text-xs text-muted-foreground mt-1">
              Please answer all questions before submitting
            </p>
          )}
        </div>
      )}

      {/* Show the response if answered (but not the "Answer questions?" error) */}
      {hasOutput && !isWaitingForInput && (
        <div className="pt-2 border-t">
          <div className="text-xs text-muted-foreground mb-1">Response:</div>
          <pre
            className={cn(
              'text-xs p-2 rounded overflow-x-auto',
              isRealError ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200' : 'bg-muted'
            )}
          >
            {typeof tool.output === 'string' ? tool.output : JSON.stringify(tool.output, null, 2)}
          </pre>
        </div>
      )}
    </ToolDisplayWrapper>
  );
}
