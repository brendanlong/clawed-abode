'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { CenteredSpinner, Spinner } from '@/components/ui/spinner';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { useVoicePlayback } from '@/hooks/useVoicePlayback';
import {
  DEFAULT_KOKORO_VOICE,
  groupKokoroVoices,
  kokoroVoiceSchema,
  resolveKokoroVoice,
} from '@/lib/kokoro-voices';
import { SettingsCard } from './shared/SettingsCard';

const VOICE_GROUPS = groupKokoroVoices();

export function AudioTab() {
  const { data: settings, isLoading, refetch } = trpc.globalSettings.get.useQuery();

  if (isLoading) {
    return <CenteredSpinner />;
  }

  return (
    <div className="space-y-6">
      {settings?.ttsEnabled ? (
        <>
          <SettingsCard
            title="Read-Aloud Voice"
            description="The Kokoro voice used to read messages aloud."
          >
            <TtsVoiceSection currentVoice={settings.ttsVoice} onUpdate={refetch} />
          </SettingsCard>

          <SettingsCard
            title="Read-Aloud Speed"
            description="How fast Kokoro speaks, from 0.25x to 4.0x. Default is 1.0x."
          >
            <TtsSpeedSection currentSpeed={settings.ttsSpeed} onUpdate={refetch} />
          </SettingsCard>
        </>
      ) : (
        <SettingsCard
          title="Read Aloud"
          description="Reading messages aloud uses Kokoro text-to-speech on the server."
        >
          <p className="text-sm text-muted-foreground">
            Not configured. Set <code>TTS_BASE_URL</code> (and <code>TTS_API_KEY</code> for
            OpenRouter) in the server environment; see <code>.env.example</code>.
          </p>
        </SettingsCard>
      )}

      <SettingsCard
        title="Auto-Send Voice Input"
        description="When enabled, speech-to-text transcripts are automatically sent as prompts after recording stops. When disabled, transcripts are inserted into the input field for editing before sending. Uses the browser's built-in speech recognition (Web Speech API)."
      >
        <VoiceAutoSendSection autoSend={settings?.voiceAutoSend ?? true} onUpdate={refetch} />
      </SettingsCard>
    </div>
  );
}

const TEST_TEXT = 'This is a test of the selected voice.';

function TtsVoiceSection({
  currentVoice,
  onUpdate,
}: {
  currentVoice: string | null;
  onUpdate: () => void;
}) {
  const mutation = trpc.globalSettings.setTtsVoice.useMutation({ onSuccess: onUpdate });
  // The shared player, because Safari refuses play() once the tap that asked for it
  // has waited seconds for synthesis; the player unlocks its element during the tap.
  const playback = useVoicePlayback(true);
  // Re-keyed per voice: identical text for the same message id would toggle pause.
  const testId = `voice-test-${currentVoice ?? DEFAULT_KOKORO_VOICE}`;

  const handleChange = (value: string) => {
    const voice = kokoroVoiceSchema.parse(value);
    mutation.mutate({ ttsVoice: voice === DEFAULT_KOKORO_VOICE ? null : voice });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select
          value={resolveKokoroVoice(currentVoice)}
          onValueChange={handleChange}
          disabled={mutation.isPending}
        >
          <SelectTrigger aria-label="Read-aloud voice" className="w-full sm:w-[260px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VOICE_GROUPS.map((group) => (
              <SelectGroup key={group.language}>
                <SelectLabel>{group.language}</SelectLabel>
                {group.voices.map((voice) => (
                  <SelectItem key={voice.id} value={voice.id}>
                    {voice.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          // Synthesizes with the saved voice and speed, which a selection has already saved.
          onClick={() => playback.play(testId, TEST_TEXT)}
          disabled={mutation.isPending}
        >
          {playback.isLoading ? <Spinner size="sm" /> : playback.isPlaying ? 'Pause' : 'Test'}
        </Button>
      </div>
      {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
      {playback.error && <p className="text-sm text-destructive">{playback.error.message}</p>}
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
