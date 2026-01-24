import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallDisplay } from './ToolCallDisplay';
import type { ToolCall } from './types';

describe('ToolCallDisplay', () => {
  describe('rendering', () => {
    it('renders tool name', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-1',
        input: { command: 'ls -la' },
        output: 'file1.txt\nfile2.txt',
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Bash')).toBeInTheDocument();
    });

    it('renders description from input when present', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-2',
        input: { command: 'npm test', description: 'Run tests' },
        output: 'All tests passed',
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Run tests')).toBeInTheDocument();
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
        output: 'command not found',
        is_error: true,
      };

      render(<ToolCallDisplay tool={tool} />);

      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    it('does not show "Running..." badge when output is present', () => {
      const tool: ToolCall = {
        name: 'Read',
        id: 'test-5',
        input: { file_path: '/test/file.txt' },
        output: 'file contents',
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
        output: 'hello',
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
        output: 'hello',
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
        output: 'content',
      };

      render(<ToolCallDisplay tool={tool} />);

      // Should show '+' when collapsed
      expect(screen.getByText('+')).toBeInTheDocument();
    });
  });

  describe('input display', () => {
    it('displays command directly for Bash tool', async () => {
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-9',
        input: { command: 'npm run build' },
        output: 'Build successful',
      };

      render(<ToolCallDisplay tool={tool} />);
      await user.click(screen.getByRole('button'));

      expect(screen.getByText('npm run build')).toBeInTheDocument();
    });

    it('displays JSON for non-Bash tools', async () => {
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'Read',
        id: 'test-10',
        input: { file_path: '/test/file.txt', limit: 100 },
        output: 'file contents',
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
        output: 'test output here',
      };

      render(<ToolCallDisplay tool={tool} />);
      await user.click(screen.getByRole('button'));

      expect(screen.getByText('test output here')).toBeInTheDocument();
    });

    it('shows JSON-formatted output for objects', async () => {
      const user = userEvent.setup();
      const tool: ToolCall = {
        name: 'CustomTool',
        id: 'test-13',
        input: { param: 'value' },
        output: { result: 'success', count: 42 },
      };

      render(<ToolCallDisplay tool={tool} />);
      await user.click(screen.getByRole('button'));

      expect(screen.getByText(/"result": "success"/)).toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('applies error styling when is_error is true', () => {
      const tool: ToolCall = {
        name: 'Bash',
        id: 'test-14',
        input: { command: 'exit 1' },
        output: 'Error occurred',
        is_error: true,
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
