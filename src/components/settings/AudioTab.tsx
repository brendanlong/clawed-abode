'use client';

import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Slider } from '@/components/ui/slider';
import { trpc } from '@/lib/trpc';
import { useVoiceConfig } from '@/hooks/useVoiceConfig';
import { useSpeechSynthesisVoices } from '@/hooks/useSpeechSynthesisVoices';
import { dedupeAndSortVoices } from '@/lib/tts';
import { SettingsCard } from './shared/SettingsCard';
import { VoicePicker } from './VoicePicker';

export function AudioTab() {
  const { data: settings, isLoading, refetch } = trpc.globalSettings.get.useQuery();

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsCard
        title="TTS Voice"
        description="Select the voice for text-to-speech playback. Available voices depend on your device and browser. This preference is stored per-device."
      >
        <TtsVoiceSection />
      </SettingsCard>

      <SettingsCard
        title="TTS Speed"
        description="Controls how fast the browser text-to-speech voice speaks (using the Web Speech API). Range: 0.25x (very slow) to 4.0x (very fast). Default is 1.0x."
      >
        <TtsSpeedSection currentSpeed={settings?.ttsSpeed ?? null} onUpdate={refetch} />
      </SettingsCard>

      <SettingsCard
        title="Auto-Send Voice Input"
        description="When enabled, speech-to-text transcripts are automatically sent as prompts after recording stops. When disabled, transcripts are inserted into the input field for editing before sending. Uses the browser's built-in speech recognition (Web Speech API)."
      >
        <VoiceAutoSendSection autoSend={settings?.voiceAutoSend ?? true} onUpdate={refetch} />
      </SettingsCard>
    </div>
  );
}

function TtsVoiceSection() {
  const { voiceURI, setVoiceURI } = useVoiceConfig();
  const availableVoices = useSpeechSynthesisVoices();
  const voices = useMemo(() => dedupeAndSortVoices(availableVoices), [availableVoices]);

  const handleTest = () => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const synth = window.speechSynthesis;
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance('This is a test of the selected voice.');
    const selectedVoice = voiceURI ? voices.find((v) => v.voiceURI === voiceURI) : null;
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }
    synth.speak(utterance);
  };

  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return (
      <p className="text-sm text-muted-foreground">
        Text-to-speech is not supported in this browser.
      </p>
    );
  }

  if (voices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No voices available. Your browser may still be loading them.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <VoicePicker
          voices={voices}
          value={voiceURI}
          onChange={setVoiceURI}
          locale={navigator.language}
        />
        <Button variant="outline" size="sm" onClick={handleTest}>
          Test
        </Button>
      </div>
    </div>
  );
}

function TtsSpeedSection({
  currentSpeed,
  onUpdate,
}: {
  currentSpeed: number | null;
  onUpdate: () => void;
}) {
  const [editValue, setEditValue] = useState(currentSpeed ?? 1.0);

  const mutation = trpc.globalSettings.setTtsSpeed.useMutation({ onSuccess: onUpdate });

  const handleChange = (value: number[]) => {
    setEditValue(value[0]);
  };

  const handleCommit = (value: number[]) => {
    mutation.mutate({ ttsSpeed: value[0] });
  };

  const handleReset = () => {
    setEditValue(1.0);
    mutation.mutate({ ttsSpeed: null });
  };

  const displaySpeed = editValue;
  const isDefault = currentSpeed === null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <code className="text-sm font-mono bg-muted px-2 py-1 rounded">{displaySpeed}x</code>
          {isDefault && <span className="text-xs text-muted-foreground">(default)</span>}
        </div>
        {!isDefault && (
          <Button variant="outline" size="sm" onClick={handleReset} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Reset to Default'}
          </Button>
        )}
      </div>
      <Slider
        value={[displaySpeed]}
        min={0.25}
        max={4.0}
        step={0.25}
        onValueChange={handleChange}
        onValueCommit={handleCommit}
      />
      <div className="relative text-xs text-muted-foreground">
        <div className="flex justify-between">
          <span>0.25x</span>
          <span>4.0x</span>
        </div>
        <span
          className="absolute -translate-x-1/2"
          style={{ left: `${((1.0 - 0.25) / (4.0 - 0.25)) * 100}%` }}
        >
          1.0x
        </span>
      </div>
      {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
    </div>
  );
}

function VoiceAutoSendSection({ autoSend, onUpdate }: { autoSend: boolean; onUpdate: () => void }) {
  const mutation = trpc.globalSettings.setVoiceAutoSend.useMutation({ onSuccess: onUpdate });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Switch
          id="voice-auto-send"
          checked={autoSend}
          onCheckedChange={(voiceAutoSend) => mutation.mutate({ voiceAutoSend })}
          disabled={mutation.isPending}
        />
        <Label htmlFor="voice-auto-send">
          {autoSend ? 'Auto-send enabled' : 'Auto-send disabled'}
        </Label>
      </div>
      {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
    </div>
  );
}
