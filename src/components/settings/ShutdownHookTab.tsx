'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { trpc } from '@/lib/trpc';

export function ShutdownHookTab() {
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
          <CardTitle>Shutdown Hook</CardTitle>
          <CardDescription>
            Run a prompt automatically when sessions are archived. Claude has the full conversation
            context and can summarize work, write journal entries, or provide feedback. The hook
            output appears in the archived session, collapsed by default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ShutdownHookSection
            key={`${settings?.shutdownHookEnabled}-${settings?.shutdownHookPrompt}`}
            enabled={settings?.shutdownHookEnabled ?? false}
            prompt={settings?.shutdownHookPrompt ?? null}
            onUpdate={refetch}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ShutdownHookSection({
  enabled,
  prompt,
  onUpdate,
}: {
  enabled: boolean;
  prompt: string | null;
  onUpdate: () => void;
}) {
  const [editEnabled, setEditEnabled] = useState(enabled);
  const [editPrompt, setEditPrompt] = useState(prompt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const mutation = trpc.globalSettings.setShutdownHook.useMutation({
    onSuccess: () => {
      setHasUnsavedChanges(false);
      onUpdate();
    },
    onError: (err) => setError(err.message),
  });

  const handleSave = () => {
    setError(null);
    mutation.mutate({
      shutdownHookPrompt: editPrompt.trim() || null,
      shutdownHookEnabled: editEnabled,
    });
  };

  const handleToggle = (checked: boolean) => {
    setEditEnabled(checked);
    setHasUnsavedChanges(true);
  };

  const handlePromptChange = (value: string) => {
    setEditPrompt(value);
    setHasUnsavedChanges(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch id="shutdown-hook-enabled" checked={editEnabled} onCheckedChange={handleToggle} />
        <Label htmlFor="shutdown-hook-enabled">{editEnabled ? 'Enabled' : 'Disabled'}</Label>
      </div>

      <div className="space-y-2">
        <Label htmlFor="shutdown-hook-prompt">Prompt Template</Label>
        <Textarea
          id="shutdown-hook-prompt"
          value={editPrompt}
          onChange={(e) => handlePromptChange(e.target.value)}
          placeholder="Write a journal entry summarizing this session's work..."
          rows={8}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Available variables: <code className="bg-muted px-1 rounded">{'{{session.name}}'}</code>,{' '}
          <code className="bg-muted px-1 rounded">{'{{session.repo}}'}</code>,{' '}
          <code className="bg-muted px-1 rounded">{'{{session.branch}}'}</code>,{' '}
          <code className="bg-muted px-1 rounded">{'{{date}}'}</code>
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={mutation.isPending || !hasUnsavedChanges}>
          {mutation.isPending ? <Spinner size="sm" /> : 'Save'}
        </Button>
        {hasUnsavedChanges && (
          <span className="text-xs text-muted-foreground">Unsaved changes</span>
        )}
      </div>
    </div>
  );
}
