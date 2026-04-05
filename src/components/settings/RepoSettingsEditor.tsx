'use client';

import { useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { Plus, Star, FileText, FolderOpen } from 'lucide-react';
import { NO_REPO_SENTINEL } from '@/components/RepoSelector';
import { EnvVarSection } from './shared/EnvVarSection';
import { McpServerSection } from './shared/McpServerSection';
import type { EnvVarMutations } from './shared/EnvVarSection';
import type { McpServerMutations } from './shared/McpServerSection';

interface RepoSettingsEditorProps {
  repoFullName: string;
  onClose: () => void;
}

function useRepoEnvVarMutations(repoFullName: string, onUpdate: () => void): EnvVarMutations {
  const utils = trpc.useUtils();
  const deleteMutation = trpc.repoSettings.deleteEnvVar.useMutation({ onSuccess: onUpdate });
  const setMutation = trpc.repoSettings.setEnvVar.useMutation();

  return {
    deleteEnvVar: async (name) => {
      await deleteMutation.mutateAsync({ repoFullName, name });
    },
    setEnvVar: async (envVar) => {
      await setMutation.mutateAsync({ repoFullName, envVar });
    },
    getSecretValue: async (name) => {
      return await utils.repoSettings.getEnvVarValue.fetch({ repoFullName, name });
    },
  };
}

function useRepoMcpServerMutations(repoFullName: string, onUpdate: () => void): McpServerMutations {
  const deleteMutation = trpc.repoSettings.deleteMcpServer.useMutation({ onSuccess: onUpdate });
  const setMutation = trpc.repoSettings.setMcpServer.useMutation();
  const validateMutation = trpc.repoSettings.validateMcpServer.useMutation();

  return {
    deleteMcpServer: async (name) => {
      await deleteMutation.mutateAsync({ repoFullName, name });
    },
    setMcpServer: async (mcpServer) => {
      await setMutation.mutateAsync({ repoFullName, mcpServer });
    },
    validateMcpServer: async (name) => {
      return await validateMutation.mutateAsync({ repoFullName, name });
    },
  };
}

export function RepoSettingsEditor({ repoFullName, onClose }: RepoSettingsEditorProps) {
  const { data, isLoading, refetch } = trpc.repoSettings.get.useQuery({ repoFullName });
  const { data: globalSettings } = trpc.globalSettings.get.useQuery();
  const toggleFavorite = trpc.repoSettings.toggleFavorite.useMutation({
    onSuccess: () => refetch(),
  });
  const setPodman = trpc.repoSettings.setEnablePodman.useMutation({ onSuccess: () => refetch() });
  const setGpu = trpc.repoSettings.setEnableGpu.useMutation({ onSuccess: () => refetch() });
  const envVarMutations = useRepoEnvVarMutations(repoFullName, refetch);
  const mcpServerMutations = useRepoMcpServerMutations(repoFullName, refetch);

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-sm">
            {repoFullName === NO_REPO_SENTINEL ? (
              <span className="flex items-center gap-1.5">
                <FolderOpen className="h-4 w-4 text-muted-foreground" />
                No Repository
              </span>
            ) : (
              <span className="font-mono">{repoFullName}</span>
            )}
          </SheetTitle>
          <SheetDescription>Configure environment variables and MCP servers</SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            {/* Favorite toggle */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Star
                  className={`h-4 w-4 ${data?.isFavorite ? 'text-yellow-500 fill-yellow-500' : 'text-muted-foreground'}`}
                />
                <Label>Favorite</Label>
              </div>
              <Switch
                checked={data?.isFavorite ?? false}
                onCheckedChange={(checked) =>
                  toggleFavorite.mutate({ repoFullName, isFavorite: checked })
                }
              />
            </div>

            <Separator />

            {/* Container Capabilities */}
            <div className="space-y-4">
              <h3 className="font-medium">Container Capabilities</h3>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">GPU Access</Label>
                  <Select
                    value={
                      data?.enableGpu === null || data?.enableGpu === undefined
                        ? 'default'
                        : data.enableGpu
                          ? 'on'
                          : 'off'
                    }
                    onValueChange={(v) =>
                      setGpu.mutate({
                        repoFullName,
                        enableGpu: v === 'default' ? null : v === 'on',
                      })
                    }
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        Default ({globalSettings?.enableGpu ? 'On' : 'Off'})
                      </SelectItem>
                      <SelectItem value="on">Enabled</SelectItem>
                      <SelectItem value="off">Disabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between">
                  <Label className="text-sm">Podman Socket</Label>
                  <Select
                    value={
                      data?.enablePodman === null || data?.enablePodman === undefined
                        ? 'default'
                        : data.enablePodman
                          ? 'on'
                          : 'off'
                    }
                    onValueChange={(v) =>
                      setPodman.mutate({
                        repoFullName,
                        enablePodman: v === 'default' ? null : v === 'on',
                      })
                    }
                  >
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">
                        Default ({globalSettings?.enablePodman ? 'On' : 'Off'})
                      </SelectItem>
                      <SelectItem value="on">Enabled</SelectItem>
                      <SelectItem value="off">Disabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-xs text-muted-foreground">
                  Podman socket gives containers the ability to create other containers with host
                  access. Only enable for repos where you need docker/podman commands.
                </p>
              </div>
            </div>

            <Separator />

            {/* Custom System Prompt */}
            <CustomSystemPromptSection
              repoFullName={repoFullName}
              customSystemPrompt={data?.customSystemPrompt ?? null}
              onUpdate={refetch}
            />

            <Separator />

            {/* Environment Variables */}
            <EnvVarSection
              envVars={data?.envVars ?? []}
              mutations={envVarMutations}
              onUpdate={refetch}
              idPrefix="env"
            />

            <Separator />

            {/* MCP Servers */}
            <McpServerSection
              mcpServers={data?.mcpServers ?? []}
              mutations={mcpServerMutations}
              onUpdate={refetch}
              idPrefix="mcp"
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CustomSystemPromptSection({
  repoFullName,
  customSystemPrompt,
  onUpdate,
}: {
  repoFullName: string;
  customSystemPrompt: string | null;
  onUpdate: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [value, setValue] = useState(customSystemPrompt ?? '');
  const [error, setError] = useState<string | null>(null);

  const mutation = trpc.repoSettings.setCustomSystemPrompt.useMutation({
    onSuccess: () => {
      setIsEditing(false);
      onUpdate();
    },
    onError: (err) => setError(err.message),
  });

  const handleSave = () => {
    setError(null);
    mutation.mutate({
      repoFullName,
      customSystemPrompt: value.trim() || null,
    });
  };

  const handleCancel = () => {
    setValue(customSystemPrompt ?? '');
    setIsEditing(false);
    setError(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium">Custom System Prompt</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        This prompt is appended to the default system prompt for all sessions using this repository.
      </p>

      {isEditing ? (
        <div className="space-y-3">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Enter custom instructions for Claude when working with this repository..."
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
      ) : customSystemPrompt ? (
        <div className="space-y-3">
          <div className="rounded-md bg-muted/50 p-3">
            <pre className="text-sm whitespace-pre-wrap font-mono">{customSystemPrompt}</pre>
          </div>
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
            Edit
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add Custom Prompt
        </Button>
      )}
    </div>
  );
}
