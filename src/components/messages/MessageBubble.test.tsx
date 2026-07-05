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

    it('renders thinking blocks as a Thinking section, not a System block', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'thinking', thinking: 'Let me reason about this.' },
              { type: 'text', text: 'Here is my answer.' },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Thinking')).toBeInTheDocument();
      expect(screen.getByText('Here is my answer.')).toBeInTheDocument();
      expect(screen.queryByText('System')).not.toBeInTheDocument();
    });

    it('coalesces multiple thinking blocks into a single Thinking section', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'thinking', thinking: 'First thought.' },
              { type: 'thinking', thinking: 'Second thought.' },
              { type: 'text', text: 'Done.' },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getAllByText('Thinking')).toHaveLength(1);
    });

    it('labels redacted thinking as redacted', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'Answer.' },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Thinking (redacted)')).toBeInTheDocument();
    });

    it('shows both visible and redacted thinking when both are present', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              { type: 'thinking', thinking: 'Visible reasoning.' },
              { type: 'redacted_thinking', data: 'opaque' },
              { type: 'text', text: 'Answer.' },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Thinking')).toBeInTheDocument();
      expect(screen.getByText('Thinking (redacted)')).toBeInTheDocument();
    });
  });

  describe('ignored system messages', () => {
    it.each(['thinking_tokens', 'task_progress', 'commands_changed', 'api_retry'])(
      'renders nothing for %s system messages',
      (subtype) => {
        const message = {
          type: 'system',
          content: { type: 'system', subtype } as MessageContent,
        };

        const { container } = render(<MessageBubble message={message} />);

        expect(container).toBeEmptyDOMElement();
      }
    );

    it('renders nothing for skip_transcript system messages', () => {
      const message = {
        type: 'system',
        content: {
          type: 'system',
          subtype: 'task_started',
          skip_transcript: true,
        } as MessageContent,
      };

      const { container } = render(<MessageBubble message={message} />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('empty assistant fragments', () => {
    it('renders nothing for an assistant message with only an empty thinking block', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'thinking', thinking: '', signature: 'sig' }],
          },
        } as MessageContent,
      };

      const { container } = render(<MessageBubble message={message} />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('generic system messages', () => {
    // System messages are hidden from the transcript to reduce noise (issue #312),
    // except errors and compact boundaries.
    it.each(['notification', 'task_started', 'task_notification', 'some_future_thing'])(
      'renders nothing for %s system messages',
      (subtype) => {
        const message = {
          type: 'system',
          content: { type: 'system', subtype, text: 'irrelevant' } as MessageContent,
        };

        const { container } = render(<MessageBubble message={message} />);

        expect(container).toBeEmptyDOMElement();
      }
    );
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

    it('shows a sanitization badge when the prompt was filtered', () => {
      const message = {
        type: 'user',
        content: {
          content: 'Please review this',
          sanitization: {
            found: ['invisible-unicode'],
            warnings: ['Stripped 1 zero-width character'],
            removed: true,
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Hidden content removed')).toBeInTheDocument();
    });

    it('does not show a sanitization badge on a clean prompt', () => {
      const message = {
        type: 'user',
        content: { content: 'Please review this' } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.queryByText('Hidden content removed')).not.toBeInTheDocument();
    });
  });

  describe('tool result messages', () => {
    it('shows a sanitization badge on a filtered tool result', () => {
      const message = {
        type: 'user',
        content: {
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: 'fetched page',
                sanitization: {
                  found: ['html-comment'],
                  warnings: ['1 HTML comment(s) replaced'],
                  removed: true,
                },
              },
            ],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText('Hidden content removed')).toBeInTheDocument();
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
    it('renders nothing for a generic system message (hidden to reduce noise)', () => {
      const message = {
        type: 'system',
        content: {
          content: 'System notification text',
        } as MessageContent,
      };

      const { container } = render(<MessageBubble message={message} />);

      expect(container).toBeEmptyDOMElement();
    });
  });

  describe('system init messages', () => {
    it('renders nothing for a session init message (hidden to reduce noise)', () => {
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

      const { container } = render(<MessageBubble message={message} />);

      expect(container).toBeEmptyDOMElement();
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
            planContentByToolUseId: new Map(),
            renderSubagentTranscript: () => null,
          }}
        >
          <MessageBubble message={message} />
        </MessageListProvider>
      );

      // TodoWriteDisplay should be rendered (check for its specific elements)
      expect(screen.getByText('TodoWrite')).toBeInTheDocument();
    });
  });

  describe('server tool use (advisor)', () => {
    it('renders an indicator for an advisor server_tool_use block', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'advisor', input: {} }],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText(/Consulted the advisor/)).toBeInTheDocument();
    });

    it('renders a generic indicator for other server tools', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [{ type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: {} }],
          },
        } as MessageContent,
      };

      render(<MessageBubble message={message} />);

      expect(screen.getByText(/Used server tool: web_search/)).toBeInTheDocument();
    });

    it('renders nothing for a message containing only an advisor_tool_result', () => {
      const message = {
        type: 'assistant',
        content: {
          message: {
            content: [
              {
                type: 'advisor_tool_result',
                tool_use_id: 'srvtoolu_1',
                content: { type: 'advisor_redacted_result', encrypted_content: 'abc' },
              },
            ],
          },
        } as MessageContent,
      };

      const { container } = render(<MessageBubble message={message} />);

      expect(container).toBeEmptyDOMElement();
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
