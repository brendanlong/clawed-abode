'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { trpc } from '@/lib/trpc';
import { Plus, Trash2, Eye, EyeOff } from 'lucide-react';

interface EnvVar {
  id: string;
  name: string;
  value: string;
  isSecret: boolean;
}

interface McpServer {
  id: string;
  name: string;
  type: 'stdio' | 'http' | 'sse';
  command: string;
  args: string[];
  env: Record<string, { value: string; isSecret: boolean }>;
  url?: string;
  headers: Record<string, { value: string; isSecret: boolean }>;
}

export function GlobalEnvVarsCard() {
  const { data, isLoading, refetch } = trpc.globalSettings.getWithSettings.useQuery();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Global Environment Variables</CardTitle>
          <CardDescription>
            Environment variables applied to all sessions. Per-repo variables with the same name
            will override these.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-6">
            <Spinner size="lg" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Global Environment Variables</CardTitle>
        <CardDescription>
          Environment variables applied to all sessions. Per-repo variables with the same name will
          override these.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <GlobalEnvVarsSection envVars={data?.envVars ?? []} onUpdate={refetch} />
      </CardContent>
    </Card>
  );
}

export function GlobalMcpServersCard() {
  const { data, isLoading, refetch } = trpc.globalSettings.getWithSettings.useQuery();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Global MCP Servers</CardTitle>
          <CardDescription>
            MCP servers available in all sessions. Per-repo servers with the same name will override
            these.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex justify-center py-6">
            <Spinner size="lg" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Global MCP Servers</CardTitle>
        <CardDescription>
          MCP servers available in all sessions. Per-repo servers with the same name will override
          these.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <GlobalMcpServersSection mcpServers={data?.mcpServers ?? []} onUpdate={refetch} />
      </CardContent>
    </Card>
  );
}

function GlobalEnvVarsSection({ envVars, onUpdate }: { envVars: EnvVar[]; onUpdate: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteEnvVar, setDeleteEnvVar] = useState<string | null>(null);
  const [revealedSecrets, setRevealedSecrets] = useState<Map<string, string>>(new Map());
  const [loadingSecret, setLoadingSecret] = useState<string | null>(null);

  const deleteMutation = trpc.globalSettings.deleteEnvVar.useMutation({
    onSuccess: () => {
      onUpdate();
      setDeleteEnvVar(null);
    },
  });

  const utils = trpc.useUtils();

  const toggleSecretVisibility = async (name: string) => {
    if (revealedSecrets.has(name)) {
      setRevealedSecrets((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
    } else {
      setLoadingSecret(name);
      try {
        const result = await utils.globalSettings.getEnvVarValue.fetch({ name });
        setRevealedSecrets((prev) => {
          const next = new Map(prev);
          next.set(name, result.value);
          return next;
        });
      } finally {
        setLoadingSecret(null);
      }
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Environment Variables</h3>
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {envVars.length === 0 && !showForm ? (
        <p className="text-sm text-muted-foreground">No global environment variables configured.</p>
      ) : (
        <ul className="space-y-2">
          {envVars.map((envVar) => (
            <li key={envVar.id} className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm">{envVar.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  {envVar.isSecret ? (
                    <>
                      <span>
                        {revealedSecrets.has(envVar.name)
                          ? revealedSecrets.get(envVar.name)
                          : '••••••••'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={() => toggleSecretVisibility(envVar.name)}
                        disabled={loadingSecret === envVar.name}
                      >
                        {loadingSecret === envVar.name ? (
                          <Spinner size="sm" className="h-3 w-3" />
                        ) : revealedSecrets.has(envVar.name) ? (
                          <EyeOff className="h-3 w-3" />
                        ) : (
                          <Eye className="h-3 w-3" />
                        )}
                      </Button>
                    </>
                  ) : (
                    <span className="truncate">{envVar.value}</span>
                  )}
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditingId(envVar.id)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteEnvVar(envVar.name)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(showForm || editingId) && (
        <GlobalEnvVarForm
          existingEnvVar={editingId ? envVars.find((e) => e.id === editingId) : undefined}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
          onSuccess={() => {
            setShowForm(false);
            setEditingId(null);
            onUpdate();
          }}
        />
      )}

      <AlertDialog open={!!deleteEnvVar} onOpenChange={(open) => !open && setDeleteEnvVar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete environment variable?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the global environment variable <strong>{deleteEnvVar}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteEnvVar && deleteMutation.mutate({ name: deleteEnvVar })}
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

function GlobalEnvVarForm({
  existingEnvVar,
  onClose,
  onSuccess,
}: {
  existingEnvVar?: EnvVar;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(existingEnvVar?.name ?? '');
  const [value, setValue] = useState(existingEnvVar?.isSecret ? '' : (existingEnvVar?.value ?? ''));
  const [isSecret, setIsSecret] = useState(existingEnvVar?.isSecret ?? false);
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.globalSettings.setEnvVar.useMutation({
    onSuccess,
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      setError(
        'Name must start with a letter or underscore and contain only alphanumeric characters and underscores'
      );
      return;
    }

    if (!existingEnvVar?.isSecret && !value) {
      setError('Value is required');
      return;
    }

    mutation.mutate({
      envVar: {
        name,
        value: existingEnvVar?.isSecret && !value ? existingEnvVar.value : value,
        isSecret,
      },
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor="global-env-name">Name</Label>
        <Input
          id="global-env-name"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="MY_API_KEY"
          disabled={!!existingEnvVar}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="global-env-value">Value</Label>
        <Input
          id="global-env-value"
          type={isSecret ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={existingEnvVar?.isSecret ? '(unchanged)' : 'Enter value'}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch id="global-env-secret" checked={isSecret} onCheckedChange={setIsSecret} />
        <Label htmlFor="global-env-secret">Secret (encrypted at rest)</Label>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner size="sm" /> : existingEnvVar ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

type McpServerType = 'stdio' | 'http' | 'sse';

function GlobalMcpServersSection({
  mcpServers,
  onUpdate,
}: {
  mcpServers: McpServer[];
  onUpdate: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteMcpServer, setDeleteMcpServer] = useState<string | null>(null);

  const deleteMutation = trpc.globalSettings.deleteMcpServer.useMutation({
    onSuccess: () => {
      onUpdate();
      setDeleteMcpServer(null);
    },
  });

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
        <p className="text-sm text-muted-foreground">No global MCP servers configured.</p>
      ) : (
        <ul className="space-y-2">
          {mcpServers.map((server) => (
            <li key={server.id} className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
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
              <Button variant="ghost" size="sm" onClick={() => setEditingId(server.id)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteMcpServer(server.name)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(showForm || editingId) && (
        <GlobalMcpServerForm
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
        />
      )}

      <AlertDialog
        open={!!deleteMcpServer}
        onOpenChange={(open) => !open && setDeleteMcpServer(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the global MCP server <strong>{deleteMcpServer}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMcpServer && deleteMutation.mutate({ name: deleteMcpServer })}
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

/** Shared key-value list editor for env vars and headers with secret support */
function KeyValueListEditor({
  label,
  entries,
  existingEntries,
  onChange,
  keyPlaceholder = 'KEY',
  keyTransform,
}: {
  label: string;
  entries: Array<{ key: string; value: string; isSecret: boolean }>;
  existingEntries?: Record<string, { value: string; isSecret: boolean }>;
  onChange: (entries: Array<{ key: string; value: string; isSecret: boolean }>) => void;
  keyPlaceholder?: string;
  keyTransform?: (key: string) => string;
}) {
  const addEntry = () => {
    onChange([...entries, { key: '', value: '', isSecret: false }]);
  };

  const removeEntry = (index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  };

  const updateEntry = (
    index: number,
    field: 'key' | 'value' | 'isSecret',
    value: string | boolean
  ) => {
    onChange(entries.map((entry, i) => (i === index ? { ...entry, [field]: value } : entry)));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{label}</Label>
        <Button type="button" variant="outline" size="sm" onClick={addEntry}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {entries.map((entry, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={entry.key}
            onChange={(e) =>
              updateEntry(
                index,
                'key',
                keyTransform ? keyTransform(e.target.value) : e.target.value
              )
            }
            placeholder={keyPlaceholder}
            className="flex-1"
          />
          <Input
            type={entry.isSecret ? 'password' : 'text'}
            value={entry.value}
            onChange={(e) => updateEntry(index, 'value', e.target.value)}
            placeholder={existingEntries?.[entry.key]?.isSecret ? '(unchanged)' : 'value'}
            className="flex-1"
          />
          <Switch
            checked={entry.isSecret}
            onCheckedChange={(checked) => updateEntry(index, 'isSecret', checked)}
            title="Secret"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => removeEntry(index)}
            className="text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function GlobalMcpServerForm({
  existingServer,
  onClose,
  onSuccess,
}: {
  existingServer?: McpServer;
  onClose: () => void;
  onSuccess: () => void;
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

  const mutation = trpc.globalSettings.setMcpServer.useMutation({
    onSuccess,
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name) {
      setError('Name is required');
      return;
    }

    if (serverType === 'stdio') {
      if (!command) {
        setError('Command is required');
        return;
      }

      const env = envVars.reduce(
        (acc, { key, value, isSecret }) => {
          if (key) {
            const existingEnv = existingServer?.env[key];
            const finalValue = existingEnv?.isSecret && !value ? existingEnv.value : value;
            acc[key] = { value: finalValue, isSecret };
          }
          return acc;
        },
        {} as Record<string, { value: string; isSecret: boolean }>
      );

      mutation.mutate({
        mcpServer: {
          name,
          type: 'stdio',
          command,
          args: args.split(/\s+/).filter(Boolean),
          env: Object.keys(env).length > 0 ? env : undefined,
        },
      });
    } else {
      if (!url) {
        setError('URL is required');
        return;
      }

      const headersRecord = headers.reduce(
        (acc, { key, value, isSecret }) => {
          if (key) {
            const existingHeader = existingServer?.headers?.[key];
            const finalValue = existingHeader?.isSecret && !value ? existingHeader.value : value;
            acc[key] = { value: finalValue, isSecret };
          }
          return acc;
        },
        {} as Record<string, { value: string; isSecret: boolean }>
      );

      mutation.mutate({
        mcpServer: {
          name,
          type: serverType,
          url,
          headers: Object.keys(headersRecord).length > 0 ? headersRecord : undefined,
        },
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor="global-mcp-name">Name</Label>
        <Input
          id="global-mcp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="memory"
          disabled={!!existingServer}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="global-mcp-type">Type</Label>
        <Select
          value={serverType}
          onValueChange={(value) => setServerType(value as McpServerType)}
          disabled={!!existingServer}
        >
          <SelectTrigger id="global-mcp-type">
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
            <Label htmlFor="global-mcp-command">Command</Label>
            <Input
              id="global-mcp-command"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="global-mcp-args">Arguments (space-separated)</Label>
            <Input
              id="global-mcp-args"
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
            <Label htmlFor="global-mcp-url">URL</Label>
            <Input
              id="global-mcp-url"
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
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <Spinner size="sm" /> : existingServer ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
