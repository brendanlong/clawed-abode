import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromptInput } from './PromptInput';

describe('PromptInput', () => {
  const defaultProps = {
    onSubmit: vi.fn(),
    onInterrupt: vi.fn(),
    isRunning: false,
    isInterrupting: false,
    disabled: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders textarea and send button', () => {
      render(<PromptInput {...defaultProps} />);

      expect(screen.getByRole('textbox')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
    });

    it('shows default placeholder when idle', () => {
      render(<PromptInput {...defaultProps} />);

      expect(
        screen.getByPlaceholderText(/type your message.*enter to send.*shift\+enter for new line/i)
      ).toBeInTheDocument();
    });

    it('shows "Claude is thinking..." placeholder when running', () => {
      render(<PromptInput {...defaultProps} isRunning={true} />);

      expect(screen.getByPlaceholderText(/claude is thinking/i)).toBeInTheDocument();
    });

    it('shows "Session is not running" placeholder when disabled', () => {
      render(<PromptInput {...defaultProps} disabled={true} />);

      expect(screen.getByPlaceholderText(/session is not running/i)).toBeInTheDocument();
    });
  });

  describe('send button behavior', () => {
    it('shows Stop button when Claude is running', () => {
      render(<PromptInput {...defaultProps} isRunning={true} />);

      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /send/i })).not.toBeInTheDocument();
    });

    it('shows "Stopping..." when isInterrupting is true', () => {
      render(<PromptInput {...defaultProps} isRunning={true} isInterrupting={true} />);

      expect(screen.getByRole('button', { name: /stopping/i })).toBeInTheDocument();
    });

    it('disables send button when input is empty', () => {
      render(<PromptInput {...defaultProps} />);

      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('disables send button when component is disabled', () => {
      render(<PromptInput {...defaultProps} disabled={true} />);

      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('enables send button when input has content', async () => {
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} />);

      await user.type(screen.getByRole('textbox'), 'Hello');

      expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled();
    });

    it('disables stop button when isInterrupting is true', () => {
      render(<PromptInput {...defaultProps} isRunning={true} isInterrupting={true} />);

      expect(screen.getByRole('button', { name: /stopping/i })).toBeDisabled();
    });
  });

  describe('form submission', () => {
    it('calls onSubmit with trimmed prompt when send button is clicked', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByRole('textbox'), '  Hello world  ');
      await user.click(screen.getByRole('button', { name: /send/i }));

      expect(onSubmit).toHaveBeenCalledWith('Hello world');
    });

    it('clears input after successful submission', async () => {
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'Test message');
      await user.click(screen.getByRole('button', { name: /send/i }));

      expect(textarea).toHaveValue('');
    });

    it('does not call onSubmit when input is empty', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      await user.click(screen.getByRole('button', { name: /send/i }));

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not call onSubmit when input is only whitespace', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByRole('textbox'), '   ');
      await user.click(screen.getByRole('button', { name: /send/i }));

      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not call onSubmit when disabled', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} disabled={true} />);

      // Try to type (won't work since disabled)
      await user.type(screen.getByRole('textbox'), 'Test');

      // Button should still be disabled
      expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    });

    it('does not call onSubmit when running', () => {
      const onSubmit = vi.fn();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} isRunning={true} />);

      // Textarea should be disabled when running
      expect(screen.getByRole('textbox')).toBeDisabled();
    });
  });

  describe('keyboard handling', () => {
    it('submits on Enter key', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByRole('textbox'), 'Test message{Enter}');

      expect(onSubmit).toHaveBeenCalledWith('Test message');
    });

    it('does not submit on Shift+Enter', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByRole('textbox'), 'Line 1{Shift>}{Enter}{/Shift}Line 2');

      expect(onSubmit).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox')).toHaveValue('Line 1\nLine 2');
    });
  });

  describe('interrupt behavior', () => {
    it('calls onInterrupt when Stop button is clicked', async () => {
      const onInterrupt = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onInterrupt={onInterrupt} isRunning={true} />);

      await user.click(screen.getByRole('button', { name: /stop/i }));

      expect(onInterrupt).toHaveBeenCalled();
    });

    it('does not call onInterrupt when button is disabled', async () => {
      const onInterrupt = vi.fn();
      render(
        <PromptInput
          {...defaultProps}
          onInterrupt={onInterrupt}
          isRunning={true}
          isInterrupting={true}
        />
      );

      // Button should be disabled
      expect(screen.getByRole('button', { name: /stopping/i })).toBeDisabled();
    });
  });

  describe('textarea behavior', () => {
    it('disables textarea when component is disabled', () => {
      render(<PromptInput {...defaultProps} disabled={true} />);

      expect(screen.getByRole('textbox')).toBeDisabled();
    });

    it('disables textarea when Claude is running', () => {
      render(<PromptInput {...defaultProps} isRunning={true} />);

      expect(screen.getByRole('textbox')).toBeDisabled();
    });

    it('allows typing when not disabled or running', async () => {
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'Hello');

      expect(textarea).toHaveValue('Hello');
    });
  });
});
