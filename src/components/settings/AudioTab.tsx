'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Check, X } from 'lucide-react';
import { trpc } from '@/lib/trpc';

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
          <CardTitle>OpenAI API Key</CardTitle>
          <CardDescription>
            Required for voice input (speech-to-text) and voice output (text-to-speech). Get a key
            at{' '}
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              platform.openai.com
            </a>
            . Text transformation (markdown to speech) also requires a Claude API key in the System
            Prompt tab.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OpenaiApiKeySection hasKey={settings?.hasOpenaiApiKey ?? false} onUpdate={refetch} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>TTS Speed</CardTitle>
          <CardDescription>
            Controls how fast the text-to-speech voice speaks. Range: 0.25x (very slow) to 4.0x
            (very fast). Default is 1.0x.
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
            editing before sending.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VoiceAutoSendSection autoSend={settings?.voiceAutoSend ?? true} onUpdate={refetch} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Voice Trigger Word</CardTitle>
          <CardDescription>
            When set, saying this word during streaming voice input will automatically submit the
            transcript to Claude. The trigger word itself is stripped from the message. For example,
            set to &quot;Over.&quot; and say &quot;Fix the bug. Over.&quot; to auto-submit &quot;Fix
            the bug.&quot; Leave empty to disable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <VoiceTriggerWordSection
            triggerWord={settings?.voiceTriggerWord ?? null}
            onUpdate={refetch}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function OpenaiApiKeySection({ hasKey, onUpdate }: { hasKey: boolean; onUpdate: () => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setOpenaiApiKey.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      setEditValue('');
      onUpdate();
    },
    onError: (err) => setError(err.message),
  });

  const handleSave = () => {
    setError(null);
    if (!editValue.trim()) {
      setError('API key cannot be empty');
      return;
    }
    mutation.mutate({ openaiApiKey: editValue.trim() });
  };

  const handleClear = () => {
    setError(null);
    mutation.mutate({ openaiApiKey: '' });
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditValue('');
    setError(null);
  };

  if (isEditing) {
    return (
      <div className="space-y-3">
        <Input
          type="password"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          placeholder="Enter OpenAI API key (sk-...)..."
          className="font-mono text-sm"
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {hasKey ? (
          <>
            <Check className="h-4 w-4 text-green-500" />
            <span className="text-sm">Configured</span>
          </>
        ) : (
          <>
            <X className="h-4 w-4 text-destructive" />
            <span className="text-sm text-destructive">Not configured</span>
          </>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
          {hasKey ? 'Update Key' : 'Set Key'}
        </Button>
        {hasKey && (
          <Button variant="outline" size="sm" onClick={handleClear} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Remove Key'}
          </Button>
        )}
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

function VoiceTriggerWordSection({
  triggerWord,
  onUpdate,
}: {
  triggerWord: string | null;
  onUpdate: () => void;
}) {
  const [editValue, setEditValue] = useState(triggerWord ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setVoiceTriggerWord.useMutation({
    onSuccess: () => onUpdate(),
    onError: (err) => setError(err.message),
  });

  const handleSave = () => {
    setError(null);
    mutation.mutate({ voiceTriggerWord: editValue.trim() || null });
  };

  const handleClear = () => {
    setError(null);
    setEditValue('');
    mutation.mutate({ voiceTriggerWord: null });
  };

  const hasChanged = (editValue.trim() || null) !== (triggerWord || null);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          placeholder='e.g., "Over."'
          className="max-w-xs"
        />
        <Button size="sm" onClick={handleSave} disabled={mutation.isPending || !hasChanged}>
          {mutation.isPending ? <Spinner size="sm" /> : 'Save'}
        </Button>
        {triggerWord && (
          <Button variant="outline" size="sm" onClick={handleClear} disabled={mutation.isPending}>
            Clear
          </Button>
        )}
      </div>
      {triggerWord && (
        <p className="text-sm text-muted-foreground">
          Current trigger word: <code className="bg-muted px-1 rounded">{triggerWord}</code>
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
