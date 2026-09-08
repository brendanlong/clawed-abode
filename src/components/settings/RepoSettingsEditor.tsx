'use client';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Separator } from '@/components/ui/separator';
import { trpc } from '@/lib/trpc';
import { fallbackClaudeModel } from '@/lib/claude-model';
import { Star, FileText, FolderOpen, Cpu } from 'lucide-react';
import { NO_REPO_SENTINEL } from '@/components/RepoSelector';
import { EnvVarSection } from './shared/EnvVarSection';
import { McpServerSection } from './shared/McpServerSection';
import { ModelOverrideField } from './shared/ModelOverrideField';
import { EditableTextSetting } from './shared/EditableTextSetting';
import type { EnvVarMutations } from './shared/EnvVarSection';
import type { McpServerMutations } from './shared/McpServerSection';

interface RepoSettingsEditorProps {
  repoFullName: string;
  onClose: () => void;
}

function useRepoEnvVarMutations(repoFullName: string): EnvVarMutations {
  const utils = trpc.useUtils();
  const deleteMutation = trpc.repoSettings.deleteEnvVar.useMutation();
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

function useRepoMcpServerMutations(repoFullName: string): McpServerMutations {
  const deleteMutation = trpc.repoSettings.deleteMcpServer.useMutation();
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
  const toggleFavorite = trpc.repoSettings.toggleFavorite.useMutation({
    onSuccess: () => refetch(),
  });
  const envVarMutations = useRepoEnvVarMutations(repoFullName);
  const mcpServerMutations = useRepoMcpServerMutations(repoFullName);

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

            <CustomSystemPromptSection
              repoFullName={repoFullName}
              customSystemPrompt={data?.customSystemPrompt ?? null}
              onUpdate={refetch}
            />

            <Separator />

            <ClaudeModelSection
              repoFullName={repoFullName}
              claudeModel={data?.claudeModel ?? null}
              onUpdate={refetch}
            />

            <Separator />

            <EnvVarSection
              envVars={data?.envVars ?? []}
              mutations={envVarMutations}
              onUpdate={refetch}
              idPrefix="env"
            />

            <Separator />

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
  const mutation = trpc.repoSettings.setCustomSystemPrompt.useMutation({ onSuccess: onUpdate });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium">Custom System Prompt</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        This prompt is appended to the default system prompt for all sessions using this repository.
      </p>

      <EditableTextSetting
        value={customSystemPrompt}
        onSave={(value, onSuccess) =>
          mutation.mutate({ repoFullName, customSystemPrompt: value }, { onSuccess })
        }
        mutation={mutation}
        placeholder="Enter custom instructions for Claude when working with this repository..."
        addLabel="Add Custom Prompt"
      />
    </div>
  );
}

function ClaudeModelSection({
  repoFullName,
  claudeModel,
  onUpdate,
}: {
  repoFullName: string;
  claudeModel: string | null;
  onUpdate: () => void;
}) {
  const { data: globalSettings } = trpc.globalSettings.get.useQuery();
  const mutation = trpc.repoSettings.setClaudeModel.useMutation({ onSuccess: onUpdate });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-muted-foreground" />
        <h3 className="font-medium">Claude Model</h3>
      </div>

      <p className="text-sm text-muted-foreground">
        Overrides the global Claude model for all sessions using this repository.
      </p>

      <ModelOverrideField
        currentModel={claudeModel}
        defaultModel={fallbackClaudeModel(globalSettings)}
        onSave={(model, onSuccess) =>
          mutation.mutate({ repoFullName, claudeModel: model }, { onSuccess })
        }
        mutation={mutation}
        setButtonLabel="Set Model"
      />
    </div>
  );
}
