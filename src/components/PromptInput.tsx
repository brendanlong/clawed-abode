'use client';

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { VoiceMicButton } from '@/components/voice/VoiceMicButton';
import { useVoiceRecording } from '@/hooks/useVoiceRecording';

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  isInterrupting: boolean;
  disabled: boolean;
  commands?: SlashCommand[];
  voiceEnabled?: boolean;
  voiceAutoSend?: boolean;
}

export function PromptInput({
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandsRef = useRef<HTMLDivElement>(null);

  // Voice recording — finalized text appends directly to prompt
  const onFinalizedText = useCallback((text: string) => {
    setPrompt((prev) => prev + text);
  }, []);

  const {
    isRecording,
    interimTranscript,
    startRecording,
    stopRecording,
    error: voiceError,
  } = useVoiceRecording(voiceEnabled ? onFinalizedText : undefined);

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

  // Derive showCommands directly from state
  const showCommands = filteredCommands.length > 0 && !disabled && !isRunning && !isDismissed;

  const insertCommand = useCallback((command: SlashCommand) => {
    const newPrompt = `/${command.name} `;
    setPrompt(newPrompt);
    // Dismiss for the new prompt value (since it will have a space, filteredCommands
    // won't match anyway, but this is defense-in-depth)
    setDismissedForPrompt(newPrompt);
    setSelectedIndex(0);
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim() && !disabled && !isRunning) {
      onSubmit(prompt.trim());
      setPrompt('');
    }
  };

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
  }, []);

  const handleMicClick = () => {
    if (isRecording) {
      const remaining = stopRecording();
      // prompt already has all finalized text via onFinalizedText callback;
      // append any remaining interim text that wasn't finalized yet
      const fullPrompt = (prompt + remaining).trim();
      setPrompt(fullPrompt);

      if (voiceAutoSend && fullPrompt && !disabled && !isRunning) {
        onSubmit(fullPrompt);
        setPrompt('');
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

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Textarea
              ref={textareaRef}
              value={isRecording && interimTranscript ? prompt + interimTranscript : prompt}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={
                disabled
                  ? 'Session is not running'
                  : isRunning
                    ? 'Claude is thinking...'
                    : isRecording
                      ? 'Listening...'
                      : 'Type your message... (Enter to send, Shift+Enter for new line)'
              }
              disabled={disabled || isRunning}
              readOnly={isRecording}
              rows={1}
              className="min-h-[44px] resize-none"
            />
          </div>

          {voiceEnabled && !isRunning && (
            <VoiceMicButton
              isRecording={isRecording}
              onClick={handleMicClick}
              disabled={disabled}
              error={voiceError}
            />
          )}

          {isRunning ? (
            <Button
              type="button"
              variant="destructive"
              onClick={onInterrupt}
              disabled={isInterrupting}
            >
              {isInterrupting ? 'Stopping...' : 'Stop'}
            </Button>
          ) : (
            <Button type="submit" disabled={!prompt.trim() || disabled}>
              Send
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
