'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { buildMcpToolFilter, type McpToolFilter, type McpToolInfo } from '@/lib/mcp-tool-filter';
import type { McpServer, ValidationResult } from '@/lib/settings-types';

interface McpToolFilterEditorProps {
  server: McpServer;
  listTools: () => Promise<ValidationResult>;
  save: (toolFilter: McpToolFilter | null) => Promise<unknown>;
  onClose: () => void;
  onSaved: () => void;
}

/** Choose which of a saved server's tools the agent gets. */
export function McpToolFilterEditor({
  server,
  listTools,
  save,
  onClose,
  onSaved,
}: McpToolFilterEditorProps) {
  const id = useId();
  const [limited, setLimited] = useState(server.toolFilter !== null);
  // Null until the user touches a checkbox: until then the selection is the
  // stored allowlist, or every tool for an unfiltered server.
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const listed = useQuery({
    queryKey: ['mcp-tools', server.id, server.updatedAt],
    queryFn: async () => {
      const result = await listTools();
      if (!result.success) throw new Error(result.error ?? 'Could not list tools');
      return result.tools ?? [];
    },
    // Listing can spawn the server, so only on open, never on focus or reconnect.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    gcTime: 0,
  });
  const tools = listed.data ?? [];
  const selection =
    selected ?? new Set(server.toolFilter?.allowed ?? tools.map((tool) => tool.name));

  const submit = useMutation({
    mutationFn: () => save(limited ? buildMcpToolFilter(tools, selection) : null),
    onSuccess: onSaved,
  });

  const toggle = (name: string, checked: boolean) => {
    const next = new Set(selection);
    if (checked) next.add(name);
    else next.delete(name);
    setSelected(next);
  };
  const selectWhere = (predicate: (tool: McpToolInfo) => boolean) =>
    setSelected(new Set(tools.filter(predicate).map((tool) => tool.name)));

  // Saving a filter needs the tool list; going back to all tools doesn't.
  const canSave = !limited || listed.data !== undefined;

  return (
    <div className="space-y-3 p-3 border rounded-md text-sm">
      <div className="flex items-center gap-2">
        <Switch id={`${id}-limit`} checked={limited} onCheckedChange={setLimited} />
        <Label htmlFor={`${id}-limit`}>Only allow selected tools</Label>
      </div>
      <p className="text-xs text-muted-foreground">
        This removes tools from the agent, but the credential keeps its access: a write-capable
        token can still write if it leaks. Tools the server adds later stay blocked until you allow
        them.
      </p>

      {limited &&
        (listed.isError ? (
          <p className="text-destructive">{listed.error.message}</p>
        ) : !listed.data ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner size="sm" /> Listing tools…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {tools.filter((tool) => selection.has(tool.name)).length} of {tools.length} allowed
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => selectWhere((tool) => tool.readOnly)}
              >
                Read-only
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => selectWhere(() => true)}
              >
                All
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => selectWhere(() => false)}
              >
                None
              </Button>
            </div>
            <ul className="space-y-1 max-h-80 overflow-y-auto">
              {tools.map((tool) => (
                <li key={tool.name} className="flex items-start gap-2">
                  <Checkbox
                    id={`${id}-${tool.name}`}
                    checked={selection.has(tool.name)}
                    onCheckedChange={(checked) => toggle(tool.name, checked === true)}
                    className="mt-0.5"
                  />
                  <Label htmlFor={`${id}-${tool.name}`} className="font-normal block min-w-0">
                    <span className="font-mono">{tool.name}</span>
                    {tool.readOnly && (
                      <Badge
                        variant="secondary"
                        className="ml-2"
                        title="The server says this tool doesn't modify anything. That's its own claim, not something the app checks."
                      >
                        read-only
                      </Badge>
                    )}
                    {tool.description && (
                      <span className="block text-xs text-muted-foreground line-clamp-2">
                        {tool.description}
                      </span>
                    )}
                  </Label>
                </li>
              ))}
            </ul>
          </>
        ))}

      {submit.error && <p className="text-destructive">{submit.error.message}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => submit.mutate()}
          disabled={!canSave || submit.isPending}
        >
          {submit.isPending ? <Spinner size="sm" /> : 'Save'}
        </Button>
      </div>
    </div>
  );
}
