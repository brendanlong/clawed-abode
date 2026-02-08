'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { trpc } from '@/lib/trpc';
import { ChevronDown, ChevronRight, RotateCcw, Check, X } from 'lucide-react';
import { GlobalEnvVarsCard, GlobalMcpServersCard } from './GlobalSettingsTab';

export function SystemPromptTab() {
  const { data: settings, isLoading, refetch } = trpc.globalSettings.get.useQuery();
  const { data: defaultPromptData } = trpc.globalSettings.getDefaultSystemPrompt.useQuery();

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
          <CardTitle>Claude Model</CardTitle>
          <CardDescription>
            The Claude model used for all sessions. Overrides the CLAUDE_MODEL environment variable
            when set.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClaudeModelSection
            currentModel={settings?.claudeModel ?? null}
            defaultModel={settings?.defaultClaudeModel ?? 'opus'}
            onUpdate={refetch}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Claude API Key</CardTitle>
          <CardDescription>
            OAuth token for Claude Code authentication. Overrides the CLAUDE_CODE_OAUTH_TOKEN
            environment variable when set. Generate with{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">claude setup-token</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClaudeApiKeySection
            hasDbKey={settings?.hasClaudeApiKey ?? false}
            hasEnvKey={settings?.hasEnvApiKey ?? false}
            onUpdate={refetch}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System Prompt Override</CardTitle>
          <CardDescription>
            Replace the default system prompt with a custom one. When disabled, the built-in default
            will be used.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SystemPromptOverrideSection
            currentOverride={settings?.systemPromptOverride ?? null}
            overrideEnabled={settings?.systemPromptOverrideEnabled ?? false}
            defaultPrompt={defaultPromptData?.defaultSystemPrompt ?? ''}
            onUpdate={refetch}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Global System Prompt Append</CardTitle>
          <CardDescription>
            Additional content appended to the system prompt for all sessions. This is added after
            the default/override prompt and before any per-repo prompts.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SystemPromptAppendSection
            currentAppend={settings?.systemPromptAppend ?? null}
            onUpdate={refetch}
          />
        </CardContent>
      </Card>

      <GlobalEnvVarsCard />

      <GlobalMcpServersCard />

      <Card>
        <CardHeader>
          <CardTitle>Default System Prompt</CardTitle>
          <CardDescription>
            The built-in system prompt used when no override is set. This ensures Claude follows the
            proper workflow for remote sessions.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DefaultPromptViewer defaultPrompt={defaultPromptData?.defaultSystemPrompt ?? ''} />
        </CardContent>
      </Card>
    </div>
  );
}

function SystemPromptOverrideSection({
  currentOverride,
  overrideEnabled,
  defaultPrompt,
  onUpdate,
}: {
  currentOverride: string | null;
  overrideEnabled: boolean;
  defaultPrompt: string;
  onUpdate: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  // When not editing, display values come from props
  // When editing, use local state initialized from props or default
  const [editValue, setEditValue] = useState('');
  const [editEnabled, setEditEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setSystemPromptOverride.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      onUpdate();
    },
    onError: (err) => setError(err.message),
  });

  const toggleMutation = trpc.globalSettings.toggleSystemPromptOverrideEnabled.useMutation({
    onSuccess: () => onUpdate(),
    onError: (err) => setError(err.message),
  });

  const handleSave = () => {
    setError(null);
    mutation.mutate({
      systemPromptOverride: editValue.trim() || null,
      systemPromptOverrideEnabled: editEnabled,
    });
  };

  const handleCancel = () => {
    setIsEditing(false);
    setError(null);
  };

  const handleResetToDefault = () => {
    setEditValue(defaultPrompt);
  };

  const handleToggleEnabled = (newEnabled: boolean) => {
    if (isEditing) {
      setEditEnabled(newEnabled);
    } else {
      toggleMutation.mutate({ enabled: newEnabled });
    }
  };

  const startEditing = () => {
    // Initialize edit state from current values
    setEditValue(currentOverride ?? defaultPrompt);
    setEditEnabled(overrideEnabled);
    setIsEditing(true);
  };

  // Use props when not editing, edit state when editing
  const displayEnabled = isEditing ? editEnabled : overrideEnabled;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch
            id="override-enabled"
            checked={displayEnabled}
            onCheckedChange={handleToggleEnabled}
            disabled={toggleMutation.isPending}
          />
          <Label htmlFor="override-enabled">
            {displayEnabled ? 'Override enabled' : 'Using default prompt'}
          </Label>
        </div>
      </div>

      {isEditing ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Custom System Prompt</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleResetToDefault}
              className="text-xs"
            >
              <RotateCcw className="h-3 w-3 mr-1" />
              Reset to Default
            </Button>
          </div>
          <Textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder="Enter your custom system prompt..."
            className="min-h-[200px] font-mono text-sm"
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
      ) : currentOverride ? (
        <div className="space-y-3">
          <div className="rounded-md bg-muted/50 p-3 max-h-[200px] overflow-y-auto">
            <pre className="text-sm whitespace-pre-wrap font-mono">{currentOverride}</pre>
          </div>
          <Button variant="outline" size="sm" onClick={startEditing}>
            Edit Override
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={startEditing}>
          Create Override
        </Button>
      )}
    </div>
  );
}

function SystemPromptAppendSection({
  currentAppend,
  onUpdate,
}: {
  currentAppend: string | null;
  onUpdate: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setSystemPromptAppend.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      onUpdate();
    },
    onError: (err) => setError(err.message),
  });

  const handleSave = () => {
    setError(null);
    mutation.mutate({
      systemPromptAppend: editValue.trim() || null,
    });
  };

  const handleCancel = () => {
    setIsEditing(false);
    setError(null);
  };

  const startEditing = () => {
    setEditValue(currentAppend ?? '');
    setIsEditing(true);
  };

  return (
    <div className="space-y-4">
      {isEditing ? (
        <div className="space-y-3">
          <Textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            placeholder="Enter additional instructions to append to all sessions..."
            className="min-h-[120px] font-mono text-sm"
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
      ) : currentAppend ? (
        <div className="space-y-3">
          <div className="rounded-md bg-muted/50 p-3 max-h-[150px] overflow-y-auto">
            <pre className="text-sm whitespace-pre-wrap font-mono">{currentAppend}</pre>
          </div>
          <Button variant="outline" size="sm" onClick={startEditing}>
            Edit
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={startEditing}>
          Add Global Append
        </Button>
      )}
    </div>
  );
}

function ClaudeModelSection({
  currentModel,
  defaultModel,
  onUpdate,
}: {
  currentModel: string | null;
  defaultModel: string;
  onUpdate: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setClaudeModel.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      onUpdate();
    },
    onError: (err) => setError(err.message),
  });

  const handleSave = () => {
    setError(null);
    mutation.mutate({ claudeModel: editValue.trim() || null });
  };

  const handleClear = () => {
    setError(null);
    mutation.mutate({ claudeModel: null });
  };

  const handleCancel = () => {
    setIsEditing(false);
    setError(null);
  };

  const startEditing = () => {
    setEditValue(currentModel ?? '');
    setIsEditing(true);
  };

  if (isEditing) {
    return (
      <div className="space-y-3">
        <Input
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          placeholder={defaultModel}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">Examples: opus, sonnet, claude-opus-4-6</p>
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
        <code className="text-sm font-mono bg-muted px-2 py-1 rounded">
          {currentModel ?? defaultModel}
        </code>
        {!currentModel && <span className="text-xs text-muted-foreground">(from environment)</span>}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={startEditing}>
          {currentModel ? 'Edit' : 'Override'}
        </Button>
        {currentModel && (
          <Button variant="outline" size="sm" onClick={handleClear} disabled={mutation.isPending}>
            {mutation.isPending ? <Spinner size="sm" /> : 'Reset to Default'}
          </Button>
        )}
      </div>
    </div>
  );
}

function ClaudeApiKeySection({
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
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setClaudeApiKey.useMutation({
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
    mutation.mutate({ claudeApiKey: editValue.trim() });
  };

  const handleClear = () => {
    setError(null);
    mutation.mutate({ claudeApiKey: '' });
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
          placeholder="Enter Claude Code OAuth token..."
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
          <Button variant="outline" size="sm" onClick={handleClear} disabled={mutation.isPending}>
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
    </div>
  );
}

function DefaultPromptViewer({ defaultPrompt }: { defaultPrompt: string }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start">
          {isOpen ? (
            <ChevronDown className="h-4 w-4 mr-2" />
          ) : (
            <ChevronRight className="h-4 w-4 mr-2" />
          )}
          {isOpen ? 'Hide default prompt' : 'Show default prompt'}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-3 rounded-md bg-muted/50 p-3 max-h-[300px] overflow-y-auto">
          <pre className="text-sm whitespace-pre-wrap font-mono">{defaultPrompt}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
