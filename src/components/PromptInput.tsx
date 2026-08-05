'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Paperclip, X, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { VoiceMicButton } from '@/components/voice/VoiceMicButton';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';
import { useFileUpload } from '@/hooks/useFileUpload';
import type { UploadedAttachment } from '@/lib/attachments';
import {
  mergeCancelledText,
  mergeCancelledAttachments,
  type CancelledPrompt,
} from '@/lib/cancelled-prompt';

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

interface PromptInputProps {
  sessionId: string;
  /**
   * Send the message. May return a promise; if it rejects, the composer restores
   * the just-typed text/attachments (so a failed send doesn't lose them) and
   * shows an inline error.
   */
  onSubmit: (prompt: string, attachments?: UploadedAttachment[]) => void | Promise<unknown>;
  /**
   * Stop the current turn. Resolves with any prompts the server pulled back
   * because the agent hadn't read them yet — the server has already deleted their
   * transcript bubbles, so the composer must take them back.
   */
  onInterrupt: () => void | Promise<CancelledPrompt[] | void>;
  isRunning: boolean;
  isInterrupting: boolean;
  disabled: boolean;
  commands?: SlashCommand[];
  voiceEnabled?: boolean;
  voiceAutoSend?: boolean;
}

export function PromptInput({
  sessionId,
  onSubmit,
  onInterrupt,
  isRunning,
  isInterrupting,
  disabled,
  commands = [],
  voiceEnabled = false,
  voiceAutoSend = true,
}: PromptInputProps) {
  const [prompt, setPrompt] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Track the prompt value when user explicitly dismissed the dropdown
  const [dismissedForPrompt, setDismissedForPrompt] = useState<string | null>(null);
  // Files uploaded and pending until the next message is sent. Not shown in the
  // transcript until submit — only as chips on the composer.
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  // Error surfaced when a send fails (e.g. a network blip). The failed
  // text/attachments are restored into the composer so they aren't lost.
  const [sendError, setSendError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandsRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { upload, uploading, error: uploadError, clearError } = useFileUpload(sessionId);

  const {
    isRecording,
    interimTranscript,
    startRecording,
    stopRecording,
    error: voiceError,
  } = useVoiceRecording();

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [prompt, interimTranscript]);

  // Determine which commands to show based on input
  const filteredCommands = useMemo(() => {
    if (commands.length === 0) return [];

    // Check if prompt starts with / and has no spaces or newlines (still typing command name)
    const match = prompt.match(/^\/(\S*)$/);
    if (!match) return [];

    const query = match[1].toLowerCase();
    if (!query) return commands;

    return commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(query) || cmd.description.toLowerCase().includes(query)
    );
  }, [prompt, commands]);

  // Dismissed only counts if the prompt hasn't changed since dismissal
  const isDismissed = dismissedForPrompt === prompt;

  // Derive showCommands directly from state. The composer stays usable while a
  // turn is running (sends interleave), so the command menu shows then too.
  const showCommands = filteredCommands.length > 0 && !disabled && !isDismissed;

  const insertCommand = useCallback((command: SlashCommand) => {
    const newPrompt = `/${command.name} `;
    setPrompt(newPrompt);
    // Dismiss for the new prompt value (since it will have a space, filteredCommands
    // won't match anyway, but this is defense-in-depth)
    setDismissedForPrompt(newPrompt);
    setSelectedIndex(0);
    textareaRef.current?.focus();
  }, []);

  // Submit is allowed with typed text OR at least one attachment, and stays
  // allowed while a turn is running — the message goes straight to the agent,
  // which reads it mid-turn.
  const canSubmit = (prompt.trim().length > 0 || attachments.length > 0) && !disabled;

  // Clear the composer optimistically for snappy input, then send. If the send
  // fails, restore the just-typed text/attachments (unless the user already began
  // a new message) and surface the error so nothing is silently lost.
  const submit = useCallback(
    (text: string, atts: UploadedAttachment[]) => {
      setPrompt('');
      setAttachments([]);
      setSendError(null);
      Promise.resolve(onSubmit(text, atts.length > 0 ? atts : undefined)).catch((err: unknown) => {
        setPrompt((current) => (current.length === 0 ? text : current));
        setAttachments((current) => (current.length === 0 ? atts : current));
        setSendError(err instanceof Error ? err.message : 'Failed to send message');
      });
    },
    [onSubmit]
  );

  // Stop can pull back prompts the agent never read. Their bubbles are already
  // gone from the transcript, so the composer is the last copy — merge them in
  // ahead of anything typed since rather than dropping either.
  const handleInterrupt = useCallback(() => {
    Promise.resolve(onInterrupt())
      .then((cancelled) => {
        if (!cancelled?.length) return;
        setPrompt((current) => mergeCancelledText(current, cancelled));
        setAttachments((current) => mergeCancelledAttachments(current, cancelled));
      })
      .catch((err: unknown) => {
        setSendError(err instanceof Error ? err.message : 'Failed to stop');
      });
  }, [onInterrupt]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (canSubmit) {
      submit(prompt.trim(), attachments);
    }
  };

  const handleFilesSelected = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      try {
        const uploaded = await upload(files);
        setAttachments((prev) => [...prev, ...uploaded]);
      } catch {
        // Error is surfaced via uploadError; nothing else to do here.
      }
    },
    [upload]
  );

  const removeAttachment = useCallback((storedName: string) => {
    setAttachments((prev) => prev.filter((a) => a.storedName !== storedName));
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        insertCommand(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissedForPrompt(prompt);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setPrompt(newValue);
    // Reset selected index when prompt changes
    setSelectedIndex(0);
    // A fresh edit dismisses a stale send error.
    setSendError(null);
  }, []);

  const handleMicClick = () => {
    if (isRecording) {
      const transcript = stopRecording();
      // Append voice transcript to any text typed before recording started
      const fullPrompt = (prompt + transcript).trim();
      setPrompt(fullPrompt);

      if (voiceAutoSend && fullPrompt && !disabled) {
        submit(fullPrompt, attachments);
      } else {
        textareaRef.current?.focus();
      }
    } else {
      startRecording();
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    if (!showCommands || !commandsRef.current) return;
    const selected = commandsRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, showCommands]);

  return (
    <form onSubmit={handleSubmit} className="border-t bg-background p-4">
      <div className="relative">
        {showCommands && (
          <div
            ref={commandsRef}
            className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto rounded-md border bg-popover shadow-md z-50"
          >
            {filteredCommands.map((command, index) => (
              <button
                key={command.name}
                type="button"
                data-selected={index === selectedIndex}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-accent cursor-pointer ${
                  index === selectedIndex ? 'bg-accent' : ''
                }`}
                onMouseDown={(e) => {
                  // Use onMouseDown to prevent textarea blur before click fires
                  e.preventDefault();
                  insertCommand(command);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono font-medium text-foreground">/{command.name}</span>
                  {command.argumentHint && (
                    <span className="text-muted-foreground text-xs">{command.argumentHint}</span>
                  )}
                </div>
                <div className="text-muted-foreground text-xs mt-0.5">{command.description}</div>
              </button>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            void handleFilesSelected(e.currentTarget.files);
            // Reset so selecting the same file again re-triggers onChange.
            e.currentTarget.value = '';
          }}
        />

        {(attachments.length > 0 || uploadError || sendError) && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {attachments.map((att) => (
              <span
                key={att.storedName}
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="max-w-[12rem] truncate" title={att.name}>
                  {att.name}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(att.storedName)}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label={`Remove ${att.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
            {uploadError && (
              <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                {uploadError}
                <button
                  type="button"
                  onClick={clearError}
                  className="hover:text-foreground"
                  aria-label="Dismiss upload error"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
            {sendError && (
              <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
                {sendError}
                <button
                  type="button"
                  onClick={() => setSendError(null)}
                  className="hover:text-foreground"
                  aria-label="Dismiss send error"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            )}
          </div>
        )}

        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading}
            title="Attach files"
            aria-label="Attach files"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Paperclip className="h-4 w-4" />
            )}
          </Button>

          <div className="flex-1">
            <Textarea
              ref={textareaRef}
              value={isRecording && interimTranscript ? prompt + interimTranscript : prompt}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={
                disabled
                  ? 'Session is not running'
                  : isRecording
                    ? 'Listening...'
                    : isRunning
                      ? "Claude is working — send anyway, it'll read it as it goes"
                      : 'Type your message... (Enter to send, Shift+Enter for new line)'
              }
              disabled={disabled}
              readOnly={isRecording}
              rows={1}
              className="min-h-[44px] resize-none"
            />
          </div>

          {voiceEnabled && (
            <VoiceMicButton
              isRecording={isRecording}
              onClick={handleMicClick}
              disabled={disabled}
              error={voiceError}
            />
          )}

          {/* While a turn runs, Stop interrupts it; Send still delivers straight
              to the agent, which reads it mid-turn. */}
          {isRunning && (
            <Button
              type="button"
              variant="destructive"
              onClick={handleInterrupt}
              disabled={isInterrupting}
            >
              {isInterrupting ? 'Stopping...' : 'Stop'}
            </Button>
          )}
          <Button type="submit" disabled={!canSubmit}>
            Send
          </Button>
        </div>
      </div>
    </form>
  );
}
