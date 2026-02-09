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
import { Plus, Trash2, Plug, Check, X } from 'lucide-react';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { KeyValueListEditor } from './KeyValueListEditor';
import {
  mcpServerSectionReducer,
  initialMcpServerSectionState,
  mcpServerFormReducer,
  createInitialMcpServerFormState,
} from './mcp-server-reducer';
import type { McpServer, McpServerType, ValidationResult } from '@/lib/settings-types';

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
}

type McpServerInput = StdioMcpServerInput | HttpSseMcpServerInput;

export interface McpServerMutations {
  deleteMcpServer: (name: string) => Promise<void>;
  setMcpServer: (mcpServer: McpServerInput) => Promise<void>;
  validateMcpServer: (name: string) => Promise<ValidationResult>;
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">MCP Servers</h3>
        <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'openForm' })}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {mcpServers.length === 0 && !state.showForm ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {mcpServers.map((server) => {
            const result = state.validationResults.get(server.name);
            const isTesting = state.validatingServer === server.name;
            return (
              <li key={server.id} className="space-y-1">
                <div className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-sm flex items-center gap-2">
                      {server.name}
                      <span className="text-xs text-muted-foreground font-sans uppercase">
                        {server.type}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {server.type === 'stdio'
                        ? `${server.command} ${server.args.join(' ')}`
                        : server.url}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleValidate(server.name)}
                    disabled={isTesting}
                    title="Test connection"
                  >
                    {isTesting ? (
                      <Spinner size="sm" className="h-4 w-4" />
                    ) : (
                      <Plug className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => dispatch({ type: 'startEditing', id: server.id })}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => dispatch({ type: 'setDeleteTarget', name: server.name })}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {result && (
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
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(state.showForm || state.editingId) && (
        <McpServerForm
          existingServer={
            state.editingId ? mcpServers.find((s) => s.id === state.editingId) : undefined
          }
          onClose={() => dispatch({ type: 'closeForm' })}
          onSuccess={() => {
            dispatch({ type: 'formSuccess' });
            onUpdate();
          }}
          setMcpServer={mutations.setMcpServer}
          idPrefix={idPrefix}
        />
      )}

      <DeleteConfirmDialog
        open={!!state.deleteTarget}
        onClose={() => dispatch({ type: 'setDeleteTarget', name: null })}
        onConfirm={handleDelete}
        title="Delete MCP server?"
        description={
          <>
            {deleteDescriptionPrefix} <strong>{state.deleteTarget}</strong>.
          </>
        }
        isPending={state.isDeleting}
      />
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

          <KeyValueListEditor
            label="Headers"
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
