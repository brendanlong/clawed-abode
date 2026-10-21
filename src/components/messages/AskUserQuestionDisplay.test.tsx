import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AskUserQuestionDisplay } from './AskUserQuestionDisplay';
import type { MessageListActions } from './MessageListContext';
import { TestMessageListProvider } from '@/test/message-list-provider';
import type { ToolCall } from './types';
import { elidedResult, inlineResult } from '@/test/tool-result-fixtures';

// An elided body would be fetched; these tests never need it to arrive.
vi.mock('@/hooks/useToolResultText', () => ({
  useToolResultText: () => ({ data: undefined, isLoading: true, isError: false }),
}));

const QUESTION_TOOL: ToolCall = {
  name: 'AskUserQuestion',
  id: 'toolu_q1',
  input: {
    questions: [
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Option A', description: 'first' },
          { label: 'Option B', description: 'second' },
        ],
      },
    ],
  },
};

function renderWithContext(tool: ToolCall, actions: Partial<MessageListActions> = {}) {
  return render(
    <TestMessageListProvider actions={actions}>
      <AskUserQuestionDisplay tool={tool} />
    </TestMessageListProvider>
  );
}

describe('AskUserQuestionDisplay', () => {
  it('answers with the tool_use id when an option is clicked', async () => {
    const onAnswerQuestion = vi.fn();
    renderWithContext(QUESTION_TOOL, { onAnswerQuestion });

    await userEvent.click(screen.getByText('Option A'));

    expect(onAnswerQuestion).toHaveBeenCalledWith('toolu_q1', { 'Which approach?': 'Option A' });
  });

  it('stays interactive regardless of any running state (no isClaudeRunning gate)', () => {
    // The fix removed the running-state gate: a pending question is always
    // answerable, and the server decides how to route the answer.
    const onAnswerQuestion = vi.fn();
    renderWithContext(QUESTION_TOOL, { onAnswerQuestion });

    const option = screen.getByText('Option A').closest('button');
    expect(option).not.toBeDisabled();
  });

  it('is read-only once the tool call has a result', () => {
    const onAnswerQuestion = vi.fn();
    renderWithContext({ ...QUESTION_TOOL, result: inlineResult('Option A') }, { onAnswerQuestion });

    expect(screen.getByRole('button', { name: /Option A/ })).toBeDisabled();
  });

  it('still waits for an answer when the CLI\'s "Answer questions?" error arrived elided', () => {
    const onAnswerQuestion = vi.fn();
    const result = { ...elidedResult('Answer questions?'), is_error: true };
    renderWithContext({ ...QUESTION_TOOL, result }, { onAnswerQuestion });

    expect(screen.getByText('Waiting for input')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Option A/ })).not.toBeDisabled();
  });
});
