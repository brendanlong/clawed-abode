import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AskUserQuestionDisplay } from './AskUserQuestionDisplay';
import { MessageListProvider } from './MessageListContext';
import type { ToolCall } from './types';

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

function renderWithContext(
  tool: ToolCall,
  ctx: Partial<React.ComponentProps<typeof MessageListProvider>['value']> = {}
) {
  return render(
    <MessageListProvider
      value={{
        latestTodoWriteId: null,
        manuallyToggledTodoIds: new Set(),
        onTodoManualToggle: vi.fn(),
        planContentByToolUseId: new Map(),
        renderSubagentTranscript: () => null,
        ...ctx,
      }}
    >
      <AskUserQuestionDisplay tool={tool} />
    </MessageListProvider>
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
    renderWithContext({ ...QUESTION_TOOL, output: 'Option A' }, { onAnswerQuestion });

    expect(screen.getByRole('button', { name: /Option A/ })).toBeDisabled();
  });

  it('falls back to text response when no tool_use id is available', async () => {
    const onSendResponse = vi.fn();
    renderWithContext({ ...QUESTION_TOOL, id: undefined }, { onSendResponse });

    await userEvent.click(screen.getByText('Option B'));

    expect(onSendResponse).toHaveBeenCalledWith('Option B');
  });
});
