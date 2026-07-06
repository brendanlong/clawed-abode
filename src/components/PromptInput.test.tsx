import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PromptInput } from './PromptInput';
import { MAX_QUEUED_MESSAGES } from '@/lib/queued-message';

describe('PromptInput', () => {
  const defaultProps = {
    sessionId: 'test-session-id',
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

    it('shows a queueing placeholder when running', () => {
      render(<PromptInput {...defaultProps} isRunning={true} />);

      expect(
        screen.getByPlaceholderText(/claude is working.*sent when it finishes/i)
      ).toBeInTheDocument();
    });

    it('shows "Session is not running" placeholder when disabled', () => {
      render(<PromptInput {...defaultProps} disabled={true} />);

      expect(screen.getByPlaceholderText(/session is not running/i)).toBeInTheDocument();
    });
  });

  describe('send button behavior', () => {
    it('shows both Stop and Queue buttons when Claude is running', () => {
      render(<PromptInput {...defaultProps} isRunning={true} />);

      // Stop interrupts the current turn; Queue sends a new message afterwards.
      expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /queue/i })).toBeInTheDocument();
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

      expect(onSubmit).toHaveBeenCalledWith('Hello world', undefined);
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

    it('queues a message (calls onSubmit) while running', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} isRunning={true} />);

      // The composer stays usable while running so messages can be queued.
      const textarea = screen.getByRole('textbox');
      expect(textarea).not.toBeDisabled();
      await user.type(textarea, 'queued message');
      await user.click(screen.getByRole('button', { name: /queue/i }));

      expect(onSubmit).toHaveBeenCalledWith('queued message', undefined);
    });
  });

  describe('send failure handling', () => {
    it('restores the typed text and shows an error when the send rejects', async () => {
      const onSubmit = vi.fn().mockRejectedValue(new Error('Queue is full'));
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'important message');
      await user.click(screen.getByRole('button', { name: /send/i }));

      // The failed text is restored so it isn't lost, and the error surfaces.
      await waitFor(() => expect(textarea).toHaveValue('important message'));
      expect(screen.getByText('Queue is full')).toBeInTheDocument();
    });

    it('does not restore text if the user started a new message before the error', async () => {
      let rejectSend: (reason: Error) => void = () => {};
      const onSubmit = vi.fn().mockReturnValue(
        new Promise((_, reject) => {
          rejectSend = reject;
        })
      );
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'first');
      await user.click(screen.getByRole('button', { name: /send/i }));
      // Composer cleared optimistically; user starts typing a new message.
      await user.type(textarea, 'second');

      rejectSend(new Error('boom'));

      // The in-progress new message is preserved (not clobbered by the restore).
      await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
      expect(textarea).toHaveValue('second');
    });

    it('clears the send error when the user edits the composer', async () => {
      const onSubmit = vi.fn().mockRejectedValue(new Error('Queue is full'));
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      const textarea = screen.getByRole('textbox');
      await user.type(textarea, 'msg');
      await user.click(screen.getByRole('button', { name: /send/i }));
      await waitFor(() => expect(screen.getByText('Queue is full')).toBeInTheDocument());

      await user.type(textarea, '!');
      expect(screen.queryByText('Queue is full')).not.toBeInTheDocument();
    });
  });

  describe('queue overflow', () => {
    it('disables submit and explains when the queue is full while running', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <PromptInput
          {...defaultProps}
          onSubmit={onSubmit}
          isRunning={true}
          queuedCount={MAX_QUEUED_MESSAGES}
        />
      );

      await user.type(screen.getByRole('textbox'), 'one more');

      const queueButton = screen.getByRole('button', { name: /queue/i });
      expect(queueButton).toBeDisabled();
      expect(screen.getByText(/messages already queued/i)).toBeInTheDocument();

      await user.click(queueButton);
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not block submit when the queue is full but no turn is running', async () => {
      // Idle sends start a turn rather than queueing, so the cap does not apply.
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(
        <PromptInput {...defaultProps} onSubmit={onSubmit} queuedCount={MAX_QUEUED_MESSAGES} />
      );

      await user.type(screen.getByRole('textbox'), 'hello');
      await user.click(screen.getByRole('button', { name: /send/i }));

      expect(onSubmit).toHaveBeenCalledWith('hello', undefined);
    });
  });

  describe('keyboard handling', () => {
    it('submits on Enter key', async () => {
      const onSubmit = vi.fn();
      const user = userEvent.setup();
      render(<PromptInput {...defaultProps} onSubmit={onSubmit} />);

      await user.type(screen.getByRole('textbox'), 'Test message{Enter}');

      expect(onSubmit).toHaveBeenCalledWith('Test message', undefined);
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

    it('keeps textarea enabled when Claude is running (messages queue)', () => {
      render(<PromptInput {...defaultProps} isRunning={true} />);

      expect(screen.getByRole('textbox')).not.toBeDisabled();
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
