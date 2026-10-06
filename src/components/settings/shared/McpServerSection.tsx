'use client';

import { useId, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
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
import { SettingsListEditor, SettingsListRow, type SettingsScope } from './SettingsListEditor';
import { KeyValueListEditor } from './KeyValueListEditor';
import { trpc } from '@/lib/trpc';
import {
  buildMcpServerInput,
  initialMcpServerForm,
  type McpServerFormFields,
} from './mcp-server-form';
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
  return (
    <SettingsListEditor
      title="MCP Servers"
      itemNoun="MCP server"
      scope={scope}
      items={mcpServers}
      onDelete={mutations.deleteMcpServer}
      onUpdate={onUpdate}
      renderRow={(server, editorActions) => (
        <McpServerRow
          server={server}
          editorActions={editorActions}
          mutations={mutations}
          onUpdate={onUpdate}
        />
      )}
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

type OAuthAction = 'connect' | 'disconnect';

function McpServerRow({
  server,
  editorActions,
  mutations,
  onUpdate,
}: {
  server: McpServer;
  editorActions: ReactNode;
  mutations: McpServerMutations;
  onUpdate: () => void;
}) {
  const validate = useMutation({ mutationFn: () => mutations.validateMcpServer(server.name) });
  // One mutation for both directions, so starting either clears the other's error.
  const oauth = useMutation({
    mutationFn: async (action: OAuthAction) => {
      if (action === 'disconnect') {
        await mutations.disconnectMcpOAuth(server.name);
        return;
      }
      // The authorization server has to talk to the user's browser, so the flow is a
      // full navigation away and back through /api/mcp/oauth/callback.
      const { authorizeUrl } = await mutations.startMcpOAuth(server.name);
      window.location.assign(authorizeUrl);
    },
    onSuccess: (_, action) => {
      if (action === 'disconnect') onUpdate();
    },
  });
  // A successful connect is mid-navigation, so it stays busy rather than flashing idle.
  const isConnecting = oauth.isPending || (oauth.isSuccess && oauth.variables === 'connect');

  return (
    <SettingsListRow
      editorActions={editorActions}
      actions={
        <>
          {server.authType === 'oauth' && (
            <>
              {/* Always offered, not just when disconnected: a grant whose refresh
                  is failing needs re-authorizing, not disconnecting first. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => oauth.mutate('connect')}
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
                  onClick={() => oauth.mutate('disconnect')}
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
            onClick={() => validate.mutate()}
            disabled={validate.isPending}
            title="Test connection"
          >
            {validate.isPending ? (
              <Spinner size="sm" className="h-4 w-4" />
            ) : (
              <Plug className="h-4 w-4" />
            )}
          </Button>
        </>
      }
      extra={
        <>
          {server.oauth && <OAuthStatusBadge status={server.oauth} />}
          {oauth.error && <ErrorBadge message={oauth.error.message} />}
          {validate.data && <ValidationResultBadge result={validate.data} />}
          {validate.error && <ErrorBadge message={validate.error.message} />}
        </>
      }
    >
      <div className="font-mono text-sm flex items-center gap-2">
        {server.name}
        <span className="text-xs text-muted-foreground font-sans uppercase">{server.type}</span>
      </div>
      <div className="text-xs text-muted-foreground truncate">
        {server.type === 'stdio' ? `${server.command} ${server.args.join(' ')}` : server.url}
      </div>
    </SettingsListRow>
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
  const update = (fields: Partial<McpServerFormFields>) => setForm((f) => ({ ...f, ...fields }));
  const redirectUri = trpc.globalSettings.getMcpOAuthRedirectUri.useQuery(undefined, {
    enabled: form.authType === 'oauth',
  }).data?.redirectUri;
  // Validation failures throw from mutationFn too, so `save.error` is the one error to show.
  const save = useMutation({
    mutationFn: async () => {
      const built = buildMcpServerInput(form, existingServer);
      if (!built.ok) throw new Error(built.error);
      await setMcpServer(built.input);
    },
    onSuccess,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate();
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

      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner size="sm" /> : existingServer ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
