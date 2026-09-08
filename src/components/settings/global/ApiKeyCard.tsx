'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { trpc } from '@/lib/trpc';
import { Check, X } from 'lucide-react';
import { SettingsCard } from '../shared/SettingsCard';

export function ApiKeyCard({
  hasDbKey,
  hasEnvKey,
  onUpdate,
}: {
  hasDbKey: boolean;
  hasEnvKey: boolean;
  onUpdate: () => void;
}) {
  return (
    <SettingsCard
      title="Claude API Key"
      description={
        <>
          OAuth token for Claude Code authentication. Overrides the CLAUDE_CODE_OAUTH_TOKEN
          environment variable when set. Generate with{' '}
          <code className="text-xs bg-muted px-1 py-0.5 rounded">claude setup-token</code>.
        </>
      }
    >
      <ApiKeyField hasDbKey={hasDbKey} hasEnvKey={hasEnvKey} onUpdate={onUpdate} />
    </SettingsCard>
  );
}

function ApiKeyField({
  hasDbKey,
  hasEnvKey,
  onUpdate,
}: {
  hasDbKey: boolean;
  hasEnvKey: boolean;
  onUpdate: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const mutation = trpc.globalSettings.setClaudeApiKey.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      setEditValue('');
      onUpdate();
    },
  });

  const handleCancel = () => {
    setIsEditing(false);
    setEditValue('');
    mutation.reset();
  };

  if (isEditing) {
    const trimmed = editValue.trim();
    return (
      <div className="space-y-3">
        <Input
          type="password"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          placeholder="Enter Claude Code OAuth token..."
          className="font-mono text-sm"
        />
        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate({ claudeApiKey: trimmed })}
            disabled={mutation.isPending || !trimmed}
          >
            {mutation.isPending ? <Spinner size="sm" /> : 'Save'}
          </Button>
        </div>
      </div>
    );
  }

  const configured = hasDbKey || hasEnvKey;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {configured ? (
          <>
            <Check className="h-4 w-4 text-green-500" />
            <span className="text-sm">Configured</span>
            {!hasDbKey && hasEnvKey && (
              <span className="text-xs text-muted-foreground">(from environment)</span>
            )}
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
          {hasDbKey ? 'Update Key' : 'Set Key'}
        </Button>
        {hasDbKey && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => mutation.mutate({ claudeApiKey: '' })}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? (
              <Spinner size="sm" />
            ) : hasEnvKey ? (
              'Reset to Default'
            ) : (
              'Remove Key'
            )}
          </Button>
        )}
      </div>
      {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
    </div>
  );
}
