import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallDisplay } from './ToolCallDisplay';
import type { ToolCall } from './types';
import { inlineResult } from '@/test/tool-result-fixtures';

describe('ToolCallDisplay', () => {
  describe('rendering', () => {
    it('renders tool name', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-1',
        input: { command: 'ls -la' },
        result: inlineResult('file1.txt\nfile2.txt'),
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    it('shows a sanitization badge when the result was filtered', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-san',
        input: { command: 'curl example.com' },
        result: {
          ...inlineResult('page'),
          sanitization: { found: ['html-comments'], warnings: [], removed: true },
        },
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Hidden content removed')).toBeInTheDocument();
    });

    it('shows no sanitization badge on a clean result', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-clean',
        input: { command: 'ls' },
        result: inlineResult('file1.txt'),
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.queryByText('Hidden content removed')).not.toBeInTheDocument();
    });

    it('renders description from input when present', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-2',
        input: { command: 'npm test', description: 'Run tests' },
        result: inlineResult('All tests passed'),
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Run tests')).toBeInTheDocument();
    });

    it('renders the rest of the display when description is not a string', () => {
      // MCP tools can put anything under `description`; a non-primitive value
      // must not reach React as a child and blank the whole display.
      const tool: ToolCall = {
        name: 'mcp__server__thing',
        id: 'test-2b',
        input: { description: { text: 'nested' } },
        result: inlineResult('done'),
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('mcp__server__thing')).toBeInTheDocument();
      expect(screen.queryByText('nested')).not.toBeInTheDocument();
    });

    it('shows "Running..." badge when output is undefined', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-3',
        input: { command: 'npm install' },
        // No output - pending state
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Running...')).toBeInTheDocument();
    });

    it('shows "Error" badge when is_error is true', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-4',
        input: { command: 'invalid-command' },
        result: inlineResult('command not found', true),
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    it('does not show "Running..." badge when output is present', () => {
      const tool: ToolCall = {
        name: 'Read',
        id: 'test-5',
        input: { file_path: '/test/file.txt' },
        result: inlineResult('file contents'),
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.queryByText('Running...')).not.toBeInTheDocument();
    });
  });

  describe('expansion behavior', () => {
    it('starts collapsed by default', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-6',
        input: { command: 'echo hello' },
        result: inlineResult('hello'),
      };

      render(<ToolCallDisplay tool={tool} />);

      // Input label should not be in the document when collapsed
      expect(screen.queryByText('Input:')).not.toBeInTheDocument();
    });

    it('expands when clicking the trigger', async () => {
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-7',
        input: { command: 'echo hello' },
        result: inlineResult('hello'),
      };

      render(<ToolCallDisplay tool={tool} />);

      // Click the collapsible trigger
      await user.click(screen.getByRole('button'));

      // Input should be visible when expanded
      expect(screen.getByText('Input:')).toBeVisible();
      expect(screen.getByText('Output:')).toBeVisible();
    });

    it('shows expand/collapse indicator', () => {
      const tool: ToolCall = {
        name: 'Read',
        id: 'test-8',
        input: { file_path: '/test.txt' },
        result: inlineResult('content'),
      };

      render(<ToolCallDisplay tool={tool} />);

      // Should show '+' when collapsed
      expect(screen.getByText('+')).toBeInTheDocument();
    });
  });

  describe('input display', () => {
    it('displays JSON-formatted input for tools in the generic fallback', async () => {
      // Bash routes to BashDisplay in ContentRenderer, so it never reaches this
      // generic display; anything that does falls through to JSON rendering.
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'SomeTool',
        id: 'test-9',
        input: { command: 'npm run build' },
        result: inlineResult('Build successful'),
      };

      render(<ToolCallDisplay tool={tool} />);
      await user.click(screen.getByRole('button'));

      expect(screen.getByText(/"command": "npm run build"/)).toBeInTheDocument();
    });

    it('displays JSON for non-Bash tools', async () => {
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'Read',
        id: 'test-10',
        input: { file_path: '/test/file.txt', limit: 100 },
        result: inlineResult('file contents'),
      };

      render(<ToolCallDisplay tool={tool} />);
      await user.click(screen.getByRole('button'));

      // Should show JSON-formatted input
      expect(screen.getByText(/"file_path": "\/test\/file.txt"/)).toBeInTheDocument();
    });
  });

  describe('output display', () => {
    it('does not show output section when pending', async () => {
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-11',
        input: { command: 'sleep 10' },
        // No output
      };

      render(<ToolCallDisplay tool={tool} />);
      await user.click(screen.getByRole('button'));

      expect(screen.getByText('Input:')).toBeVisible();
      expect(screen.queryByText('Output:')).not.toBeInTheDocument();
    });

    it('shows string output directly', async () => {
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-12',
        input: { command: 'echo test' },
        result: inlineResult('test output here'),
      };

      render(<ToolCallDisplay tool={tool} />);
      await user.click(screen.getByRole('button'));

      expect(screen.getByText('test output here')).toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('applies error styling when is_error is true', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-14',
        input: { command: 'exit 1' },
        result: inlineResult('Error occurred', true),
      };

      const { container } = render(<ToolCallDisplay tool={tool} />);

      // Check for error border class
      const card = container.querySelector('[class*="border-red"]');
      expect(card).toBeInTheDocument();
    });

    it('applies pending styling when no output', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-15',
        input: { command: 'long-running' },
        // No output
      };

      const { container } = render(<ToolCallDisplay tool={tool} />);

      // Check for pending border class
      const card = container.querySelector('[class*="border-yellow"]');
      expect(card).toBeInTheDocument();
    });
  });
});
