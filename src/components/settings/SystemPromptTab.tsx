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
import { SUGGESTED_ADVISOR_MODEL } from '@/lib/advisor';
import {
  SETTING_SOURCES,
  DEFAULT_SETTING_SOURCE_FLAGS,
  type SettingSource,
  type SettingSourceFlags,
} from '@/lib/setting-sources';
import { ChevronDown, ChevronRight, RotateCcw, Check, X } from 'lucide-react';
import { GlobalEnvVarsCard, GlobalMcpServersCard } from './GlobalSettingsTab';
import { ModelOverrideField } from './shared/ModelOverrideField';

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
            defaultModel={settings?.defaultClaudeModel ?? 'opus[1m]'}
            onUpdate={refetch}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Advisor Model</CardTitle>
          <CardDescription>
            The model used by the server-side advisor tool, which Claude can consult for a second
            opinion during a session. Disabled by default — set a model to enable it for all
            sessions. Takes effect after a session is stopped and restarted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AdvisorModelSection
            currentModel={settings?.advisorModel ?? null}
            suggestedModel={settings?.suggestedAdvisorModel ?? SUGGESTED_ADVISOR_MODEL}
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
          <CardTitle>Usage Limits</CardTitle>
          <CardDescription>
            Show subscription usage limits (session and weekly) next to the context indicator.
            Requires your claude.ai session cookie: open claude.ai in a browser, then copy the{' '}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">sessionKey</code> cookie value
            from devtools (Application → Cookies). The organization is auto-detected unless set
            explicitly.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UsageLimitsSection
            hasCookie={settings?.hasClaudeAiSessionCookie ?? false}
            orgId={settings?.claudeAiOrgId ?? null}
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

      <Card>
        <CardHeader>
          <CardTitle>Load Claude Settings From</CardTitle>
          <CardDescription>
            Which scopes Claude Code loads settings, skills, hooks, and CLAUDE.md from for every
            session. Takes effect after a session is stopped and restarted. See the{' '}
            <a
              href="https://code.claude.com/docs/en/settings#available-scopes"
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              settings scopes docs
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SettingSourcesSection
            current={settings?.settingSources ?? DEFAULT_SETTING_SOURCE_FLAGS}
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

const SETTING_SOURCE_LABELS: Record<SettingSource, { title: string; description: string }> = {
  user: {
    title: 'User',
    description: '~/.claude — the home directory of the account running the app.',
  },
  project: {
    title: 'Project',
    description: '<workspace>/.claude — config committed to the checked-out repository.',
  },
  local: {
    title: 'Local',
    description: '<workspace>/.claude/settings.local.json — uncommitted local overrides.',
  },
};

function SettingSourcesSection({
  current,
  onUpdate,
}: {
  current: SettingSourceFlags;
  onUpdate: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setSettingSources.useMutation({
    onSuccess: () => onUpdate(),
    onError: (err) => setError(err.message),
  });

  const handleToggle = (source: SettingSource, checked: boolean) => {
    setError(null);
    mutation.mutate({ ...current, [source]: checked });
  };

  return (
    <div className="space-y-4">
      {SETTING_SOURCES.map((source) => (
        <div key={source} className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor={`setting-source-${source}`}>
              {SETTING_SOURCE_LABELS[source].title}
            </Label>
            <p className="text-sm text-muted-foreground">
              {SETTING_SOURCE_LABELS[source].description}
            </p>
          </div>
          <Switch
            id={`setting-source-${source}`}
            checked={current[source]}
            onCheckedChange={(checked) => handleToggle(source, checked)}
            disabled={mutation.isPending}
          />
        </div>
      ))}
      {error && <p className="text-sm text-destructive">{error}</p>}
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
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setClaudeModel.useMutation({
    onSuccess: () => onUpdate(),
    onError: (err) => setError(err.message),
  });

  return (
    <ModelOverrideField
      currentModel={currentModel}
      defaultModel={defaultModel}
      onSave={(claudeModel, onSuccess) => {
        setError(null);
        mutation.mutate({ claudeModel }, { onSuccess });
      }}
      isPending={mutation.isPending}
      error={error}
    />
  );
}

function AdvisorModelSection({
  currentModel,
  suggestedModel,
  onUpdate,
}: {
  currentModel: string | null;
  suggestedModel: string;
  onUpdate: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setAdvisorModel.useMutation({
    onSuccess: () => onUpdate(),
    onError: (err) => setError(err.message),
  });

  return (
    <ModelOverrideField
      currentModel={currentModel}
      defaultModel={suggestedModel}
      emptyLabel="Disabled"
      emptyHint={null}
      setButtonLabel="Enable"
      clearButtonLabel="Disable"
      emptySavesDefault
      onSave={(advisorModel, onSuccess) => {
        setError(null);
        mutation.mutate({ advisorModel }, { onSuccess });
      }}
      isPending={mutation.isPending}
      error={error}
    />
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

function UsageLimitsSection({
  hasCookie,
  orgId,
  onUpdate,
}: {
  hasCookie: boolean;
  orgId: string | null;
  onUpdate: () => void;
}) {
  const [isEditingCookie, setIsEditingCookie] = useState(false);
  const [cookieValue, setCookieValue] = useState('');
  const [orgIdValue, setOrgIdValue] = useState(orgId ?? '');
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  // Live fetch status so a bad cookie is debuggable from the settings page.
  const { data: usage } = trpc.claude.getUsageLimits.useQuery(undefined, {
    enabled: hasCookie,
    refetchOnWindowFocus: false,
  });

  const cookieMutation = trpc.globalSettings.setClaudeAiSessionCookie.useMutation({
    onSuccess: () => {
      setIsEditingCookie(false);
      setCookieValue('');
      onUpdate();
      void utils.claude.getUsageLimits.invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const orgIdMutation = trpc.globalSettings.setClaudeAiOrgId.useMutation({
    onSuccess: () => {
      onUpdate();
      void utils.claude.getUsageLimits.invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const handleSaveCookie = () => {
    setError(null);
    if (!cookieValue.trim()) {
      setError('Session cookie cannot be empty');
      return;
    }
    cookieMutation.mutate({ claudeAiSessionCookie: cookieValue.trim() });
  };

  const handleClearCookie = () => {
    setError(null);
    cookieMutation.mutate({ claudeAiSessionCookie: '' });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Label>Session Cookie</Label>
        {isEditingCookie ? (
          <>
            <Input
              type="password"
              value={cookieValue}
              onChange={(e) => setCookieValue(e.target.value)}
              placeholder="sessionKey value from claude.ai..."
              className="font-mono text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsEditingCookie(false);
                  setCookieValue('');
                  setError(null);
                }}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSaveCookie} disabled={cookieMutation.isPending}>
                {cookieMutation.isPending ? <Spinner size="sm" /> : 'Save'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              {hasCookie ? (
                <>
                  <Check className="h-4 w-4 text-green-500" />
                  <span className="text-sm">Configured</span>
                </>
              ) : (
                <>
                  <X className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Not configured</span>
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setIsEditingCookie(true)}>
                {hasCookie ? 'Update Cookie' : 'Set Cookie'}
              </Button>
              {hasCookie && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClearCookie}
                  disabled={cookieMutation.isPending}
                >
                  {cookieMutation.isPending ? <Spinner size="sm" /> : 'Remove Cookie'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="claude-ai-org-id">Organization ID (optional)</Label>
        <div className="flex gap-2">
          <Input
            id="claude-ai-org-id"
            value={orgIdValue}
            onChange={(e) => setOrgIdValue(e.target.value)}
            placeholder="Auto-detected"
            className="font-mono text-sm"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              orgIdMutation.mutate({ claudeAiOrgId: orgIdValue.trim() || null });
            }}
            disabled={orgIdMutation.isPending || (orgIdValue.trim() || null) === orgId}
          >
            {orgIdMutation.isPending ? <Spinner size="sm" /> : 'Save'}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {hasCookie && usage && (
        <div className="flex items-center gap-2 text-sm">
          {usage.error ? (
            <>
              <X className="h-4 w-4 text-destructive" />
              <span className="text-destructive">Fetch failed: {usage.error}</span>
            </>
          ) : usage.limits ? (
            <>
              <Check className="h-4 w-4 text-green-500" />
              <span className="text-muted-foreground">
                Working —{' '}
                {usage.limits.map((limit) => `${limit.kind} ${limit.percent}%`).join(', ')}
              </span>
            </>
          ) : null}
        </div>
      )}
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
