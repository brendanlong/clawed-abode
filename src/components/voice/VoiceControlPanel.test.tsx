import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VoiceControlPanel } from './VoiceControlPanel';

// Controllable recording mock: a real state hook so pressing the mic genuinely
// toggles isRecording and re-renders, and stopRecording yields a fixed transcript.
const { recordingState } = vi.hoisted(() => ({
  recordingState: { transcript: 'dictated message' },
}));

vi.mock('@/hooks/useVoiceRecording', () => ({
  useVoiceRecording: () => {
    const [isRecording, setIsRecording] = useState(false);
    return {
      isRecording,
      interimTranscript: '',
      startRecording: () => setIsRecording(true),
      stopRecording: () => {
        setIsRecording(false);
        return recordingState.transcript;
      },
      error: null,
    };
  },
}));

const { voiceConfigState } = vi.hoisted(() => ({
  voiceConfigState: { autoSend: true },
}));

vi.mock('@/hooks/useVoiceConfig', () => ({
  useVoiceConfig: () => ({
    enabled: true,
    sttEnabled: true,
    ttsEnabled: true,
    autoRead: false,
    setAutoRead: vi.fn(),
    autoSend: voiceConfigState.autoSend,
    ttsSpeed: 1.0,
    voiceURI: null,
    setVoiceURI: vi.fn(),
  }),
}));

vi.mock('@/hooks/useVoicePlayback', () => ({
  useVoicePlaybackContext: () => ({
    enabled: true,
    isPlaying: false,
    currentMessageId: null,
    supportsPause: false,
    play: vi.fn(),
    enqueue: vi.fn(),
    pause: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
  }),
}));

// jsdom has no Wake Lock API; leave it undefined so the effect's guard skips it.

describe('VoiceControlPanel send-failure handling', () => {
  const defaultProps = {
    sessionId: 'test-session-id',
    messages: [],
    isRunning: false,
    onSendPrompt: vi.fn(),
    onClose: vi.fn(),
    onInterrupt: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    recordingState.transcript = 'dictated message';
    voiceConfigState.autoSend = true;
  });

  it('auto-send: restores the transcript and shows an error when the send rejects', async () => {
    voiceConfigState.autoSend = true;
    const onSendPrompt = vi.fn().mockRejectedValue(new Error('Queue is full'));
    const user = userEvent.setup();
    render(<VoiceControlPanel {...defaultProps} onSendPrompt={onSendPrompt} />);

    const mic = screen.getByRole('button', { name: /start recording/i });
    await user.click(mic); // start recording
    await user.click(screen.getByRole('button', { name: /stop recording/i })); // stop -> auto-send

    expect(onSendPrompt).toHaveBeenCalledWith('dictated message');
    // The transcript is restored into the review area and the error surfaces.
    await waitFor(() => expect(screen.getByText('dictated message')).toBeInTheDocument());
    expect(screen.getByText('Queue is full')).toBeInTheDocument();
  });

  it('manual send: restores the transcript and shows an error when the send rejects', async () => {
    voiceConfigState.autoSend = false;
    const onSendPrompt = vi.fn().mockRejectedValue(new Error('Session is not running'));
    const user = userEvent.setup();
    render(<VoiceControlPanel {...defaultProps} onSendPrompt={onSendPrompt} />);

    const mic = screen.getByRole('button', { name: /start recording/i });
    await user.click(mic);
    await user.click(screen.getByRole('button', { name: /stop recording/i })); // stop -> pending review

    // Transcript is in the review area; press Send.
    expect(await screen.findByText('dictated message')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^send$/i }));

    expect(onSendPrompt).toHaveBeenCalledWith('dictated message');
    // Restored (still shown) and error surfaced.
    await waitFor(() => expect(screen.getByText('Session is not running')).toBeInTheDocument());
    expect(screen.getByText('dictated message')).toBeInTheDocument();
  });

  it('does not show an error when the send succeeds', async () => {
    voiceConfigState.autoSend = true;
    const onSendPrompt = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<VoiceControlPanel {...defaultProps} onSendPrompt={onSendPrompt} />);

    await user.click(screen.getByRole('button', { name: /start recording/i }));
    await user.click(screen.getByRole('button', { name: /stop recording/i }));

    expect(onSendPrompt).toHaveBeenCalledWith('dictated message');
    // Nothing restored, no error, no lingering transcript.
    await waitFor(() => expect(onSendPrompt).toHaveBeenCalled());
    expect(screen.queryByText('dictated message')).not.toBeInTheDocument();
  });

  it('cancel clears a send error', async () => {
    voiceConfigState.autoSend = false;
    const onSendPrompt = vi.fn().mockRejectedValue(new Error('Queue is full'));
    const user = userEvent.setup();
    render(<VoiceControlPanel {...defaultProps} onSendPrompt={onSendPrompt} />);

    await user.click(screen.getByRole('button', { name: /start recording/i }));
    await user.click(screen.getByRole('button', { name: /stop recording/i }));
    await user.click(screen.getByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText('Queue is full')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByText('Queue is full')).not.toBeInTheDocument();
    expect(screen.queryByText('dictated message')).not.toBeInTheDocument();
  });
});
