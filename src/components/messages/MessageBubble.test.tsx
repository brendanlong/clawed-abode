import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import { MessageListProvider } from './MessageListContext';
import type { ToolResultMap, MessageContent } from './types';

describe('MessageBubble', () => {
  describe('unrecognized messages', () => {
    it('shows raw JSON for unrecognized message types', () => {
      const message = {
        type: 'unknown_type',
        content: { someField: 'value' },
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText(/Unknown: unknown_type/)).toBeInTheDocument();
    });

    it('shows raw JSON for assistant messages without content array', () => {
      const message = {
        type: 'assistant',
        content: { message: { invalid: true } }, // No content array
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText(/Unknown: assistant/)).toBeInTheDocument();
    });
  });

  describe('assistant messages', () => {
    it('renders text content from assistant message', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Hello, how can I help you today?' }],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Hello, how can I help you today?')).toBeInTheDocument();
    });

    it('renders multiple text blocks joined', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'text', text: 'First paragraph.' },
              { type: 'text', text: 'Second paragraph.' },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText(/First paragraph/)).toBeInTheDocument();
      expect(screen.getByText(/Second paragraph/)).toBeInTheDocument();
    });

    it('shows tool calls from assistant messages', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'text', text: 'Let me check that file.' },
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test.txt' } },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Let me check that file.')).toBeInTheDocument();
      expect(screen.getByText('Read')).toBeInTheDocument();
    });

    it('shows tool results when provided', () => {
      const toolResults: ToolResultMap = new Map([
        ['tool-1', { content: 'file contents here', is_error: false }],
      ]);

      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test.txt' } },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} toolResults={toolResults} />);

      expect(screen.getByText('Read')).toBeInTheDocument();
    });

    it('shows interrupted indicator when message was interrupted', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'text', text: 'I was about to...' }],
          },
          interrupted: true,
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('May be incomplete')).toBeInTheDocument();
    });
  });

  describe('user messages', () => {
    it('renders simple user prompt', () => {
      const message = {
        type: 'user',
        content: {
          content: 'Can you help me with this code?',
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Can you help me with this code?')).toBeInTheDocument();
    });

    it('renders user message with content array', () => {
      // User messages with message.content array are recognized as user,
      // but the display uses content.content which should contain the text blocks
      const message = {
        type: 'user',
        content: {
          message: {
            content: [{ type: 'text', text: 'User prompt text' }],
          },
          content: [{ type: 'text', text: 'User prompt text' }],
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('User prompt text')).toBeInTheDocument();
    });
  });

  describe('user interrupt messages', () => {
    it('shows interrupt indicator', () => {
      const message = {
        type: 'user',
        content: {
          subtype: 'interrupt',
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Interrupted')).toBeInTheDocument();
    });
  });

  describe('system messages', () => {
    it('renders system message with badge', () => {
      const message = {
        type: 'system',
        content: {
          content: 'System notification text',
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('System')).toBeInTheDocument();
      expect(screen.getByText('System notification text')).toBeInTheDocument();
    });
  });

  describe('system init messages', () => {
    it('renders session started display', () => {
      const message = {
        type: 'system',
        content: {
          subtype: 'init',
          model: 'claude-3-opus',
          claude_code_version: '1.0.0',
          session_id: 'test-session-123',
          cwd: '/workspace',
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Session Started')).toBeInTheDocument();
      expect(screen.getByText(/claude-3-opus/)).toBeInTheDocument();
    });
  });

  describe('system error messages', () => {
    it('renders error badge and content', () => {
      const message = {
        type: 'system',
        content: {
          subtype: 'error',
          content: [{ type: 'text', text: 'An error occurred' }],
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  describe('result messages', () => {
    it('renders turn complete display', () => {
      const message = {
        type: 'result',
        content: {
          subtype: 'success',
          session_id: 'test-session',
          total_cost_usd: 0.0123,
          num_turns: 3,
          duration_ms: 5000,
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Turn Complete')).toBeInTheDocument();
      expect(screen.getByText(/\$0\.0123/)).toBeInTheDocument();
    });

    it('renders error result', () => {
      const message = {
        type: 'result',
        content: {
          subtype: 'error',
          session_id: 'test-session',
          num_turns: 1,
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Error')).toBeInTheDocument();
    });
  });

  describe('tool result messages', () => {
    it('renders tool result display for tool_result content', () => {
      const message = {
        type: 'user',
        content: {
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: 'Tool execution output',
              },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      // Should render as tool result, not user message
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });
  });

  describe('copy functionality', () => {
    it('renders copy button for all message types', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'text', text: 'Test message' }],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      // CopyButton should be present
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });
  });

  describe('TodoWrite tracking', () => {
    it('renders TodoWrite tool display when context is provided', () => {
      const onTodoManualToggle = vi.fn();
      const manuallyToggledTodoIds = new Set<string>();

      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'todo-1',
                name: 'TodoWrite',
                input: {
                  todos: [{ content: 'Task 1', status: 'pending', activeForm: 'Doing task' }],
                },
              },
            ],
          },
        } as MessageContent,
      };

      render(
        <MessageListProvider
          value={{
            latestTodoWriteId: 'todo-1',
            manuallyToggledTodoIds,
            onTodoManualToggle,
            latestPlanContent: null,
          }}
        >
          <MessageBubble message={message} />
        </MessageListProvider>
      );

      // TodoWriteDisplay should be rendered (check for its specific elements)
      expect(screen.getByText('TodoWrite')).toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('applies user message styling', () => {
      const message = {
        type: 'user',
        content: {
          content: 'User message',
        } as MessageContent,
      };

      const { container } = render(<MessageBubble message={message} />);

      // User messages have bg-primary class
      const userBubble = container.querySelector('[class*="bg-primary"]');
      expect(userBubble).toBeInTheDocument();
    });

    it('applies assistant message styling', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'text', text: 'Assistant response' }],
          },
        } as MessageContent,
      };

      const { container } = render(<MessageBubble message={message} />);

      // Assistant messages have bg-card and border
      const assistantBubble = container.querySelector('[class*="bg-card"]');
      expect(assistantBubble).toBeInTheDocument();
    });
  });
});
