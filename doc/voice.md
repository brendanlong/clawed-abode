# Voice Mode

Hands-free speech input/output using **browser-native Web Speech APIs** — no API keys or server-side processing. STT: `SpeechRecognition` (Chrome/Edge/Safari; not Firefox without a flag). TTS: `SpeechSynthesis` (rate driven by the TTS Speed setting; the Voice Auto-Send setting controls whether transcripts send immediately or land in the composer for editing).

Hooks: [`useVoiceRecording`](../src/hooks/useVoiceRecording.ts) (STT with interim transcripts), [`useVoicePlayback`](../src/hooks/useVoicePlayback.ts) (TTS via React Context, sequential queue for auto-read), [`useVoiceConfig`](../src/hooks/useVoiceConfig.ts) (support detection, per-session auto-read preference, server settings). UI: [`src/components/voice/`](../src/components/voice/) — `VoiceControlPanel` (replaces `PromptInput` when active; its send path restores the transcript on a failed send, like the composer), `VoiceMicButton`, `MessagePlayButton`, `VoiceAutoReadToggle`.

Browser quirks the code works around (keep these in mind when touching playback):

- Chrome kills utterances over ~15s ([Chromium bug](https://issues.chromium.org/issues/41294170)) — long text is chunked at sentence boundaries.
- Android: `speechSynthesis.pause()` acts as `cancel()`, so pause/resume doesn't work there.
- Backgrounded tabs may silence/cancel `SpeechSynthesis`.
- iOS requires user activation for `speak()`.
