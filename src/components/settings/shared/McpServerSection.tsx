'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Plug, Check, X, KeyRound, TriangleAlert, Unplug } from 'lucide-react';
import { SettingsListEditor, type SettingsScope } from './SettingsListEditor';
import { KeyValueListEditor } from './KeyValueListEditor';
import { buildKeyValueRecord } from '@/lib/key-value-entries';
import { trpc } from '@/lib/trpc';
import { initialMcpServerForm, type McpServerFormFields } from './mcp-server-form';
import {
  mcpAuthTypeSchema,
  mcpServerTypeSchema,
  type McpServer,
  type ValidationResult,
} from '@/lib/settings-types';
import type { McpServerInput } from '@/server/services/settings-helpers';

export interface McpServerMutations {
  deleteMcpServer: (name: string) => Promise<unknown>;
  setMcpServer: (mcpServer: McpServerInput) => Promise<unknown>;
  validateMcpServer: (name: string) => Promise<ValidationResult>;
  startMcpOAuth: (name: string) => Promise<{ authorizeUrl: string }>;
  disconnectMcpOAuth: (name: string) => Promise<unknown>;
}

interface McpServerSectionProps {
  mcpServers: McpServer[];
  mutations: McpServerMutations;
  onUpdate: () => void;
  scope: SettingsScope;
}

export function McpServerSection({
  mcpServers,
  mutations,
  onUpdate,
  scope,
}: McpServerSectionProps) {
  const [validationResults, setValidationResults] = useState<ReadonlyMap<string, ValidationResult>>(
    new Map()
  );
  const [validatingServer, setValidatingServer] = useState<string | null>(null);
  /** Server whose OAuth flow is being prepared (discovery + registration happen server-side). */
  const [connectingServer, setConnectingServer] = useState<string | null>(null);
  /** Why starting an OAuth flow failed, by server name. */
  const [connectErrors, setConnectErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const handleValidate = async (name: string) => {
    setValidatingServer(name);
    let result: ValidationResult;
    try {
      result = await mutations.validateMcpServer(name);
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : 'Validation failed' };
    }
    setValidationResults((prev) => new Map(prev).set(name, result));
    setValidatingServer(null);
  };

  const startConnecting = (name: string) => {
    setConnectingServer(name);
    setConnectErrors((prev) => {
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  };

  const connectFailed = (name: string, err: unknown, fallback: string) => {
    setConnectingServer(null);
    setConnectErrors((prev) =>
      new Map(prev).set(name, err instanceof Error ? err.message : fallback)
    );
  };

  // The authorization server has to talk to the user's browser, so the flow is a
  // full navigation away and back through /api/mcp/oauth/callback.
  const handleConnect = async (name: string) => {
    startConnecting(name);
    try {
      const { authorizeUrl } = await mutations.startMcpOAuth(name);
      window.location.assign(authorizeUrl);
    } catch (err) {
      connectFailed(name, err, 'Could not start authorization');
    }
  };

  const handleDisconnect = async (name: string) => {
    startConnecting(name);
    try {
      await mutations.disconnectMcpOAuth(name);
      setConnectingServer(null);
      onUpdate();
    } catch (err) {
      connectFailed(name, err, 'Could not disconnect');
    }
  };

  return (
    <SettingsListEditor
      title="MCP Servers"
      itemNoun="MCP server"
      scope={scope}
      items={mcpServers}
      onDelete={mutations.deleteMcpServer}
      onUpdate={onUpdate}
      renderItem={(server) => (
        <>
          <div className="font-mono text-sm flex items-center gap-2">
            {server.name}
            <span className="text-xs text-muted-foreground font-sans uppercase">{server.type}</span>
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {server.type === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url}
          </div>
        </>
      )}
      extraItemActions={(server) => {
        const isTesting = validatingServer === server.name;
        const isConnecting = connectingServer === server.name;
        return (
          <>
            {server.authType === 'oauth' && (
              <>
                {/* Always offered, not just when disconnected: a grant whose refresh
                    is failing needs re-authorizing, not disconnecting first. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleConnect(server.name)}
                  disabled={isConnecting}
                  title={
                    server.oauth?.state === 'connected'
                      ? 'Re-authorize with OAuth'
                      : 'Connect with OAuth'
                  }
                >
                  {isConnecting ? (
                    <Spinner size="sm" className="h-4 w-4" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                </Button>
                {server.oauth?.state === 'connected' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDisconnect(server.name)}
                    disabled={isConnecting}
                    title="Disconnect"
                  >
                    <Unplug className="h-4 w-4" />
                  </Button>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleValidate(server.name)}
              disabled={isTesting}
              title="Test connection"
            >
              {isTesting ? <Spinner size="sm" className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
            </Button>
          </>
        );
      }}
      renderItemExtra={(server) => {
        const result = validationResults.get(server.name);
        const connectError = connectErrors.get(server.name);
        return (
          <>
            {server.oauth && <OAuthStatusBadge status={server.oauth} />}
            {connectError ? <ErrorBadge message={connectError} /> : null}
            {result ? <ValidationResultBadge result={result} /> : null}
          </>
        );
      }}
      renderForm={({ existingItem, onClose, onSuccess }) => (
        <McpServerForm
          existingServer={existingItem}
          onClose={onClose}
          onSuccess={onSuccess}
          setMcpServer={mutations.setMcpServer}
        />
      )}
    />
  );
}

const BADGE_CLASS = 'text-xs px-2 py-1 rounded flex items-center gap-1';
const OK_CLASS = 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950';
const BAD_CLASS = 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950';
const WARN_CLASS = 'text-amber-700 bg-amber-50 dark:text-amber-400 dark:bg-amber-950';

function ErrorBadge({ message }: { message: string }) {
  return (
    <div className={`${BADGE_CLASS} ${BAD_CLASS}`}>
      <X className="h-3 w-3 shrink-0" />
      {message}
    </div>
  );
}

function OAuthStatusBadge({ status }: { status: NonNullable<McpServer['oauth']> }) {
  if (status.state !== 'connected') {
    return (
      <ErrorBadge
        message={status.error ?? 'Not authorized \u2014 use Connect to sign in with OAuth'}
      />
    );
  }
  // Tokens are stored but the last refresh failed for a reason that might be
  // transient; say so rather than reporting a flat "Authorized".
  if (status.error) {
    return (
      <div className={`${BADGE_CLASS} ${WARN_CLASS}`}>
        <TriangleAlert className="h-3 w-3 shrink-0" />
        Authorized, but the last refresh failed: {status.error}
      </div>
    );
  }
  return (
    <div className={`${BADGE_CLASS} ${OK_CLASS}`}>
      <Check className="h-3 w-3 shrink-0" />
      Authorized{status.scope ? ` \u2014 ${status.scope}` : ''}
    </div>
  );
}

function ValidationResultBadge({ result }: { result: ValidationResult }) {
  return (
    <div className={`${BADGE_CLASS} ${result.success ? OK_CLASS : BAD_CLASS}`}>
      {result.success ? (
        <>
          <Check className="h-3 w-3" />
          Connected
          {result.tools && result.tools.length > 0
            ? ` \u2014 ${result.tools.length} tool${result.tools.length === 1 ? '' : 's'}`
            : ''}
        </>
      ) : (
        <>
          <X className="h-3 w-3" />
          {result.error}
        </>
      )}
    </div>
  );
}

function McpServerForm({
  existingServer,
  onClose,
  onSuccess,
  setMcpServer,
}: {
  existingServer?: McpServer;
  onClose: () => void;
  onSuccess: () => void;
  setMcpServer: McpServerMutations['setMcpServer'];
}) {
  const id = useId();
  const [form, setForm] = useState(() => initialMcpServerForm(existingServer));
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const update = (fields: Partial<McpServerFormFields>) => setForm((f) => ({ ...f, ...fields }));
  const redirectUri = trpc.globalSettings.getMcpOAuthRedirectUri.useQuery(undefined, {
    enabled: form.authType === 'oauth',
  }).data?.redirectUri;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const fail = (message: string) => {
      setError(message);
      setIsPending(false);
    };

    if (!form.name) {
      fail('Name is required');
      return;
    }

    setError(null);
    setIsPending(true);
    try {
      if (form.serverType === 'stdio') {
        if (!form.command) {
          fail('Command is required');
          return;
        }

        const env = buildKeyValueRecord(form.envVars, existingServer?.env, 'environment variable');
        if (!env.ok) {
          fail(env.error);
          return;
        }

        await setMcpServer({
          name: form.name,
          type: 'stdio',
          command: form.command,
          args: form.args.split(/\s+/).filter(Boolean),
          env: Object.keys(env.record).length > 0 ? env.record : undefined,
        });
      } else {
        if (!form.url) {
          fail('URL is required');
          return;
        }

        const headers = buildKeyValueRecord(form.headers, existingServer?.headers, 'header');
        if (!headers.ok) {
          fail(headers.error);
          return;
        }

        await setMcpServer({
          name: form.name,
          type: form.serverType,
          url: form.url,
          headers: Object.keys(headers.record).length > 0 ? headers.record : undefined,
          authType: form.authType,
          oauth:
            form.authType === 'oauth'
              ? {
                  clientId: form.oauthClientId.trim(),
                  clientSecret: form.oauthClientSecret,
                  scope: form.oauthScope.trim(),
                }
              : undefined,
        });
      }
      onSuccess();
    } catch (err) {
      fail(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={form.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="memory"
          disabled={!!existingServer}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-type`}>Type</Label>
        <Select
          value={form.serverType}
          onValueChange={(value) => update({ serverType: mcpServerTypeSchema.parse(value) })}
          disabled={!!existingServer}
        >
          <SelectTrigger id={`${id}-type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">Stdio (command)</SelectItem>
            <SelectItem value="http">HTTP</SelectItem>
            <SelectItem value="sse">SSE (Server-Sent Events)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {form.serverType === 'stdio' ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${id}-command`}>Command</Label>
            <Input
              id={`${id}-command`}
              value={form.command}
              onChange={(e) => update({ command: e.target.value })}
              placeholder="npx"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${id}-args`}>Arguments (space-separated)</Label>
            <Input
              id={`${id}-args`}
              value={form.args}
              onChange={(e) => update({ args: e.target.value })}
              placeholder="@anthropic/mcp-server-memory"
            />
          </div>

          <KeyValueListEditor
            label="Environment Variables"
            entries={form.envVars}
            existingEntries={existingServer?.env}
            onChange={(envVars) => update({ envVars })}
            keyTransform={(key) => key.toUpperCase()}
          />
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${id}-url`}>URL</Label>
            <Input
              id={`${id}-url`}
              value={form.url}
              onChange={(e) => update({ url: e.target.value })}
              placeholder="https://mcp.example.com/sse"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${id}-auth`}>Authentication</Label>
            <Select
              value={form.authType}
              onValueChange={(value) => update({ authType: mcpAuthTypeSchema.parse(value) })}
            >
              <SelectTrigger id={`${id}-auth`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="headers">Static headers</SelectItem>
                <SelectItem value="oauth">OAuth</SelectItem>
              </SelectContent>
            </Select>
            {form.authType === 'oauth' && (
              <p className="text-xs text-muted-foreground">
                Save the server, then use Connect to sign in. The access token is refreshed
                automatically and sent as the Authorization header.
              </p>
            )}
          </div>

          {form.authType === 'oauth' && (
            <>
              <div className="space-y-2">
                <Label htmlFor={`${id}-oauth-client-id`}>OAuth Client ID (optional)</Label>
                <Input
                  id={`${id}-oauth-client-id`}
                  value={form.oauthClientId}
                  onChange={(e) => update({ oauthClientId: e.target.value })}
                  placeholder="Leave blank to register automatically"
                />
                <p className="text-xs text-muted-foreground">
                  Needed only for servers without dynamic client registration (Google, Microsoft
                  Entra). Register the client with redirect URI{' '}
                  <code className="font-mono">{redirectUri ?? '(set APP_URL to see this)'}</code>.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${id}-oauth-client-secret`}>OAuth Client Secret (optional)</Label>
                <Input
                  id={`${id}-oauth-client-secret`}
                  type="password"
                  value={form.oauthClientSecret}
                  onChange={(e) => update({ oauthClientSecret: e.target.value })}
                  placeholder={
                    existingServer?.oauth?.clientId ? 'Leave blank to keep the stored secret' : ''
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${id}-oauth-scope`}>Scope (optional)</Label>
                <Input
                  id={`${id}-oauth-scope`}
                  value={form.oauthScope}
                  onChange={(e) => update({ oauthScope: e.target.value })}
                  placeholder="Leave blank to use the scopes the server advertises"
                />
              </div>
            </>
          )}

          <KeyValueListEditor
            label={form.authType === 'oauth' ? 'Additional Headers' : 'Headers'}
            entries={form.headers}
            existingEntries={existingServer?.headers}
            onChange={(headers) => update({ headers })}
            keyPlaceholder="Header-Name"
          />
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? <Spinner size="sm" /> : existingServer ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
