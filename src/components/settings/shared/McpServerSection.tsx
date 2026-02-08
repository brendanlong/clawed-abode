'use client';

import { useState } from 'react';
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus, Trash2, Plug, Check, X } from 'lucide-react';
import { KeyValueListEditor } from './KeyValueListEditor';
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
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [validationResults, setValidationResults] = useState<Map<string, ValidationResult>>(
    new Map()
  );
  const [validatingServer, setValidatingServer] = useState<string | null>(null);

  const handleValidate = async (name: string) => {
    setValidatingServer(name);
    try {
      const result = await mutations.validateMcpServer(name);
      setValidationResults((prev) => new Map(prev).set(name, result));
    } catch (err) {
      setValidationResults((prev) =>
        new Map(prev).set(name, {
          success: false,
          error: err instanceof Error ? err.message : 'Validation failed',
        })
      );
    } finally {
      setValidatingServer(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await mutations.deleteMcpServer(deleteTarget);
      setDeleteTarget(null);
      onUpdate();
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">MCP Servers</h3>
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {mcpServers.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {mcpServers.map((server) => {
            const result = validationResults.get(server.name);
            const isTesting = validatingServer === server.name;
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
                  <Button variant="ghost" size="sm" onClick={() => setEditingId(server.id)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(server.name)}
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

      {(showForm || editingId) && (
        <McpServerForm
          existingServer={editingId ? mcpServers.find((s) => s.id === editingId) : undefined}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
          onSuccess={() => {
            setShowForm(false);
            setEditingId(null);
            onUpdate();
          }}
          setMcpServer={mutations.setMcpServer}
          idPrefix={idPrefix}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDescriptionPrefix} <strong>{deleteTarget}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const [name, setName] = useState(existingServer?.name ?? '');
  const [serverType, setServerType] = useState<McpServerType>(existingServer?.type ?? 'stdio');
  const [command, setCommand] = useState(existingServer?.command ?? '');
  const [args, setArgs] = useState(existingServer?.args.join(' ') ?? '');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string; isSecret: boolean }>>(
    existingServer?.env
      ? Object.entries(existingServer.env).map(([key, { value, isSecret }]) => ({
          key,
          value: isSecret ? '' : value,
          isSecret,
        }))
      : []
  );
  const [url, setUrl] = useState(existingServer?.url ?? '');
  const [headers, setHeaders] = useState<Array<{ key: string; value: string; isSecret: boolean }>>(
    existingServer?.headers
      ? Object.entries(existingServer.headers).map(([key, { value, isSecret }]) => ({
          key,
          value: isSecret ? '' : value,
          isSecret,
        }))
      : []
  );
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name) {
      setError('Name is required');
      return;
    }

    setIsPending(true);
    try {
      if (serverType === 'stdio') {
        if (!command) {
          setError('Command is required');
          setIsPending(false);
          return;
        }

        const env = envVars.reduce(
          (acc, { key, value, isSecret }) => {
            if (key) {
              acc[key] = { value, isSecret };
            }
            return acc;
          },
          {} as Record<string, { value: string; isSecret: boolean }>
        );

        await setMcpServer({
          name,
          type: 'stdio',
          command,
          args: args.split(/\s+/).filter(Boolean),
          env: Object.keys(env).length > 0 ? env : undefined,
        });
      } else {
        if (!url) {
          setError('URL is required');
          setIsPending(false);
          return;
        }

        const headersRecord = headers.reduce(
          (acc, { key, value, isSecret }) => {
            if (key) {
              acc[key] = { value, isSecret };
            }
            return acc;
          },
          {} as Record<string, { value: string; isSecret: boolean }>
        );

        await setMcpServer({
          name,
          type: serverType,
          url,
          headers: Object.keys(headersRecord).length > 0 ? headersRecord : undefined,
        });
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="memory"
          disabled={!!existingServer}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-type`}>Type</Label>
        <Select
          value={serverType}
          onValueChange={(value) => setServerType(value as McpServerType)}
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

      {serverType === 'stdio' ? (
        <>
          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-command`}>Command</Label>
            <Input
              id={`${idPrefix}-command`}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor={`${idPrefix}-args`}>Arguments (space-separated)</Label>
            <Input
              id={`${idPrefix}-args`}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="@anthropic/mcp-server-memory"
            />
          </div>

          <KeyValueListEditor
            label="Environment Variables"
            entries={envVars}
            existingEntries={existingServer?.env}
            onChange={setEnvVars}
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
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp.example.com/sse"
            />
          </div>

          <KeyValueListEditor
            label="Headers"
            entries={headers}
            existingEntries={existingServer?.headers}
            onChange={setHeaders}
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
