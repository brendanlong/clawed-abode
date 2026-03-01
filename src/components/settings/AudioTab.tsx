'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { useVoiceConfig } from '@/hooks/useVoiceConfig';

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
      <Card>
        <CardHeader>
          <CardTitle>TTS Voice</CardTitle>
          <CardDescription>
            Select the voice for text-to-speech playback. Available voices depend on your device and
            browser. This preference is stored per-device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TtsVoiceSection />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>TTS Speed</CardTitle>
          <CardDescription>
            Controls how fast the browser text-to-speech voice speaks (using the Web Speech API).
            Range: 0.25x (very slow) to 4.0x (very fast). Default is 1.0x.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TtsSpeedSection currentSpeed={settings?.ttsSpeed ?? null} onUpdate={refetch} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-Send Voice Input</CardTitle>
          <CardDescription>
            When enabled, speech-to-text transcripts are automatically sent as prompts after
            recording stops. When disabled, transcripts are inserted into the input field for
            editing before sending. Uses the browser&apos;s built-in speech recognition (Web Speech
            API).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VoiceAutoSendSection autoSend={settings?.voiceAutoSend ?? true} onUpdate={refetch} />
        </CardContent>
      </Card>
    </div>
  );
}

const AUTO_DETECT_VALUE = '__auto__';

function TtsVoiceSection() {
  const { voiceURI, setVoiceURI } = useVoiceConfig();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    const synth = window.speechSynthesis;
    const loadVoices = () => {
      const available = synth.getVoices();
      // Deduplicate by voiceURI (some platforms report duplicates)
      const seen = new Set<string>();
      const unique = available.filter((v) => {
        if (seen.has(v.voiceURI)) return false;
        seen.add(v.voiceURI);
        return true;
      });
      // Sort by language then name
      unique.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
      setVoices(unique);
    };

    loadVoices();
    synth.addEventListener('voiceschanged', loadVoices);
    return () => {
      synth.removeEventListener('voiceschanged', loadVoices);
    };
  }, []);

  const handleChange = (value: string) => {
    setVoiceURI(value === AUTO_DETECT_VALUE ? null : value);
  };

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
        <Select value={voiceURI ?? AUTO_DETECT_VALUE} onValueChange={handleChange}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Auto-detect" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_DETECT_VALUE}>Auto-detect (match browser language)</SelectItem>
            {voices.map((v) => (
              <SelectItem key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang}){v.localService ? '' : ' [network]'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setTtsSpeed.useMutation({
    onSuccess: () => onUpdate(),
    onError: (err) => setError(err.message),
  });

  const handleChange = (value: number[]) => {
    setEditValue(value[0]);
  };

  const handleCommit = (value: number[]) => {
    setError(null);
    mutation.mutate({ ttsSpeed: value[0] });
  };

  const handleReset = () => {
    setError(null);
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
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function VoiceAutoSendSection({ autoSend, onUpdate }: { autoSend: boolean; onUpdate: () => void }) {
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setVoiceAutoSend.useMutation({
    onSuccess: () => onUpdate(),
    onError: (err) => setError(err.message),
  });

  const handleToggle = (checked: boolean) => {
    setError(null);
    mutation.mutate({ voiceAutoSend: checked });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <Switch
          id="voice-auto-send"
          checked={autoSend}
          onCheckedChange={handleToggle}
          disabled={mutation.isPending}
        />
        <Label htmlFor="voice-auto-send">
          {autoSend ? 'Auto-send enabled' : 'Auto-send disabled'}
        </Label>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
