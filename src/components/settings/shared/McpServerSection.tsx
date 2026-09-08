'use client';

import { useReducer } from 'react';
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
import { Plug, Check, X, KeyRound, Unplug } from 'lucide-react';
import { SettingsListEditor } from './SettingsListEditor';
import { KeyValueListEditor } from './KeyValueListEditor';
import { MCP_OAUTH_CALLBACK_PATH } from '@/lib/mcp-oauth-urls';
import {
  mcpServerSectionReducer,
  initialMcpServerSectionState,
  mcpServerFormReducer,
  createInitialMcpServerFormState,
} from './mcp-server-reducer';
import type { McpAuthType, McpServer, McpServerType, ValidationResult } from '@/lib/settings-types';

interface StdioMcpServerInput {
  name: string;
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, { value: string; isSecret: boolean }>;
}

interface HttpSseMcpServerInput {
  name: string;
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, { value: string; isSecret: boolean }>;
  authType: McpAuthType;
  oauth?: { clientId: string; clientSecret: string; scope: string };
}

type McpServerInput = StdioMcpServerInput | HttpSseMcpServerInput;

export interface McpServerMutations {
  deleteMcpServer: (name: string) => Promise<void>;
  setMcpServer: (mcpServer: McpServerInput) => Promise<void>;
  validateMcpServer: (name: string) => Promise<ValidationResult>;
  startMcpOAuth: (name: string) => Promise<{ authorizeUrl: string }>;
  disconnectMcpOAuth: (name: string) => Promise<void>;
}

interface McpServerSectionProps {
  mcpServers: McpServer[];
  mutations: McpServerMutations;
  onUpdate: () => void;
  emptyMessage?: string;
  deleteDescriptionPrefix?: string;
  idPrefix?: string;
}

export function McpServerSection({
  mcpServers,
  mutations,
  onUpdate,
  emptyMessage = 'No MCP servers configured.',
  deleteDescriptionPrefix = 'This will delete the MCP server',
  idPrefix = 'mcp',
}: McpServerSectionProps) {
  const [state, dispatch] = useReducer(mcpServerSectionReducer, initialMcpServerSectionState);

  const handleValidate = async (name: string) => {
    dispatch({ type: 'startValidating', name });
    try {
      const result = await mutations.validateMcpServer(name);
      dispatch({ type: 'setValidationResult', name, result });
    } catch (err) {
      dispatch({
        type: 'setValidationResult',
        name,
        result: {
          success: false,
          error: err instanceof Error ? err.message : 'Validation failed',
        },
      });
    }
  };

  // The authorization server has to talk to the user's browser, so the flow is a
  // full navigation away and back through /api/mcp/oauth/callback.
  const handleConnect = async (name: string) => {
    dispatch({ type: 'startConnecting', name });
    try {
      const { authorizeUrl } = await mutations.startMcpOAuth(name);
      window.location.assign(authorizeUrl);
    } catch (err) {
      dispatch({
        type: 'connectFailed',
        name,
        error: err instanceof Error ? err.message : 'Could not start authorization',
      });
    }
  };

  const handleDisconnect = async (name: string) => {
    dispatch({ type: 'startConnecting', name });
    try {
      await mutations.disconnectMcpOAuth(name);
      dispatch({ type: 'connectFinished', name });
      onUpdate();
    } catch (err) {
      dispatch({
        type: 'connectFailed',
        name,
        error: err instanceof Error ? err.message : 'Could not disconnect',
      });
    }
  };

  const handleDelete = async () => {
    if (!state.deleteTarget) return;
    dispatch({ type: 'startDeleting' });
    try {
      await mutations.deleteMcpServer(state.deleteTarget);
      dispatch({ type: 'finishDeleting' });
      onUpdate();
    } catch {
      dispatch({ type: 'finishDeleting' });
    }
  };

  return (
    <SettingsListEditor
      title="MCP Servers"
      items={mcpServers}
      state={state}
      dispatch={dispatch}
      onDelete={handleDelete}
      emptyMessage={emptyMessage}
      deleteDialogTitle="Delete MCP server?"
      deleteDescriptionPrefix={deleteDescriptionPrefix}
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
        const isTesting = state.validatingServer === server.name;
        const isConnecting = state.connectingServer === server.name;
        return (
          <>
            {server.authType === 'oauth' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  server.oauth?.state === 'connected'
                    ? handleDisconnect(server.name)
                    : handleConnect(server.name)
                }
                disabled={isConnecting}
                title={server.oauth?.state === 'connected' ? 'Disconnect' : 'Connect with OAuth'}
              >
                {isConnecting ? (
                  <Spinner size="sm" className="h-4 w-4" />
                ) : server.oauth?.state === 'connected' ? (
                  <Unplug className="h-4 w-4" />
                ) : (
                  <KeyRound className="h-4 w-4" />
                )}
              </Button>
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
        const result = state.validationResults.get(server.name);
        const connectError = state.connectErrors.get(server.name);
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
          onSuccess={() => {
            onSuccess();
            onUpdate();
          }}
          setMcpServer={mutations.setMcpServer}
          idPrefix={idPrefix}
        />
      )}
    />
  );
}

const BADGE_CLASS = 'text-xs px-2 py-1 rounded flex items-center gap-1';
const OK_CLASS = 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950';
const BAD_CLASS = 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950';

function ErrorBadge({ message }: { message: string }) {
  return (
    <div className={`${BADGE_CLASS} ${BAD_CLASS}`}>
      <X className="h-3 w-3 shrink-0" />
      {message}
    </div>
  );
}

function OAuthStatusBadge({ status }: { status: NonNullable<McpServer['oauth']> }) {
  if (status.state === 'connected') {
    return (
      <div className={`${BADGE_CLASS} ${OK_CLASS}`}>
        <Check className="h-3 w-3 shrink-0" />
        Authorized{status.scope ? ` \u2014 ${status.scope}` : ''}
      </div>
    );
  }
  return (
    <ErrorBadge
      message={status.error ?? 'Not authorized \u2014 use Connect to sign in with OAuth'}
    />
  );
}

function ValidationResultBadge({ result }: { result: ValidationResult }) {
  return (
    <div
      className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${
        result.success
          ? 'text-green-700 bg-green-50 dark:text-green-400 dark:bg-green-950'
          : 'text-red-700 bg-red-50 dark:text-red-400 dark:bg-red-950'
      }`}
    >
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
  idPrefix,
}: {
  existingServer?: McpServer;
  onClose: () => void;
  onSuccess: () => void;
  setMcpServer: McpServerMutations['setMcpServer'];
  idPrefix: string;
}) {
  const [form, dispatch] = useReducer(mcpServerFormReducer, existingServer, (existing) =>
    createInitialMcpServerFormState(existing)
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.name) {
      dispatch({ type: 'setError', error: 'Name is required' });
      return;
    }

    dispatch({ type: 'startSubmit' });
    try {
      if (form.serverType === 'stdio') {
        if (!form.command) {
          dispatch({ type: 'submitError', error: 'Command is required' });
          return;
        }

        const env = form.envVars.reduce(
          (acc, { key, value, isSecret }) => {
            if (key) {
              acc[key] = { value, isSecret };
            }
            return acc;
          },
          {} as Record<string, { value: string; isSecret: boolean }>
        );

        await setMcpServer({
          name: form.name,
          type: 'stdio',
          command: form.command,
          args: form.args.split(/\s+/).filter(Boolean),
          env: Object.keys(env).length > 0 ? env : undefined,
        });
      } else {
        if (!form.url) {
          dispatch({ type: 'submitError', error: 'URL is required' });
          return;
        }

        const headersRecord = form.headers.reduce(
          (acc, { key, value, isSecret }) => {
            if (key) {
              acc[key] = { value, isSecret };
            }
            return acc;
          },
          {} as Record<string, { value: string; isSecret: boolean }>
        );

        await setMcpServer({
          name: form.name,
          type: form.serverType,
          url: form.url,
          headers: Object.keys(headersRecord).length > 0 ? headersRecord : undefined,
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
      dispatch({
        type: 'submitError',
        error: err instanceof Error ? err.message : 'An error occurred',
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) => dispatch({ type: 'setName', name: e.target.value })}
          placeholder="memory"
          disabled={!!existingServer}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-type`}>Type</Label>
        <Select
          value={form.serverType}
          onValueChange={(value) =>
            dispatch({ type: 'setServerType', serverType: value as McpServerType })
          }
          disabled={!!existingServer}
        >
          <SelectTrigger id={`${idPrefix}-type`}>
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
            <Label htmlFor={`${idPrefix}-command`}>Command</Label>
            <Input
              id={`${idPrefix}-command`}
              value={form.command}
              onChange={(e) => dispatch({ type: 'setCommand', command: e.target.value })}
              placeholder="npx"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-args`}>Arguments (space-separated)</Label>
            <Input
              id={`${idPrefix}-args`}
              value={form.args}
              onChange={(e) => dispatch({ type: 'setArgs', args: e.target.value })}
              placeholder="@anthropic/mcp-server-memory"
            />
          </div>

          <KeyValueListEditor
            label="Environment Variables"
            entries={form.envVars}
            existingEntries={existingServer?.env}
            onChange={(envVars) => dispatch({ type: 'setEnvVars', envVars })}
            keyPlaceholder="KEY"
            keyTransform={(key) => key.toUpperCase()}
          />
        </>
      ) : (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-url`}>URL</Label>
            <Input
              id={`${idPrefix}-url`}
              value={form.url}
              onChange={(e) => dispatch({ type: 'setUrl', url: e.target.value })}
              placeholder="https://mcp.example.com/sse"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-auth`}>Authentication</Label>
            <Select
              value={form.authType}
              onValueChange={(value) =>
                dispatch({ type: 'setAuthType', authType: value as McpAuthType })
              }
            >
              <SelectTrigger id={`${idPrefix}-auth`}>
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
                <Label htmlFor={`${idPrefix}-oauth-client-id`}>OAuth Client ID (optional)</Label>
                <Input
                  id={`${idPrefix}-oauth-client-id`}
                  value={form.oauthClientId}
                  onChange={(e) => dispatch({ type: 'setOauthClientId', clientId: e.target.value })}
                  placeholder="Leave blank to register automatically"
                />
                <p className="text-xs text-muted-foreground">
                  Needed only for servers without dynamic client registration (Google, Microsoft
                  Entra). Register the client with redirect URI{' '}
                  <code className="font-mono">
                    {typeof window === 'undefined' ? '' : window.location.origin}
                    {MCP_OAUTH_CALLBACK_PATH}
                  </code>
                  .
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-oauth-client-secret`}>
                  OAuth Client Secret (optional)
                </Label>
                <Input
                  id={`${idPrefix}-oauth-client-secret`}
                  type="password"
                  value={form.oauthClientSecret}
                  onChange={(e) =>
                    dispatch({ type: 'setOauthClientSecret', clientSecret: e.target.value })
                  }
                  placeholder={
                    existingServer?.oauth?.clientId ? 'Leave blank to keep the stored secret' : ''
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`${idPrefix}-oauth-scope`}>Scope (optional)</Label>
                <Input
                  id={`${idPrefix}-oauth-scope`}
                  value={form.oauthScope}
                  onChange={(e) => dispatch({ type: 'setOauthScope', scope: e.target.value })}
                  placeholder="Leave blank to use the scopes the server advertises"
                />
              </div>
            </>
          )}

          <KeyValueListEditor
            label={form.authType === 'oauth' ? 'Additional Headers' : 'Headers'}
            entries={form.headers}
            existingEntries={existingServer?.headers}
            onChange={(headers) => dispatch({ type: 'setHeaders', headers })}
            keyPlaceholder="Header-Name"
          />
        </>
      )}

      {form.error && <p className="text-sm text-destructive">{form.error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={form.isPending}>
          {form.isPending ? <Spinner size="sm" /> : existingServer ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
