'use client';

import { trpc } from '@/lib/trpc';
import { SettingsCard } from '../shared/SettingsCard';
import { EnvVarSection } from '../shared/EnvVarSection';
import { McpServerSection } from '../shared/McpServerSection';
import type { EnvVarMutations } from '../shared/EnvVarSection';
import type { McpServerMutations } from '../shared/McpServerSection';

function useGlobalEnvVarMutations(): EnvVarMutations {
  const utils = trpc.useUtils();
  const deleteMutation = trpc.globalSettings.deleteEnvVar.useMutation();
  const setMutation = trpc.globalSettings.setEnvVar.useMutation();

  return {
    deleteEnvVar: (name) => deleteMutation.mutateAsync({ name }),
    setEnvVar: (envVar) => setMutation.mutateAsync({ envVar }),
    getSecretValue: (name) => utils.globalSettings.getEnvVarValue.fetch({ name }),
  };
}

function useGlobalMcpServerMutations(): McpServerMutations {
  const deleteMutation = trpc.globalSettings.deleteMcpServer.useMutation();
  const setMutation = trpc.globalSettings.setMcpServer.useMutation();
  const validateMutation = trpc.globalSettings.validateMcpServer.useMutation();
  const startOAuthMutation = trpc.globalSettings.startMcpOAuth.useMutation();
  const disconnectOAuthMutation = trpc.globalSettings.disconnectMcpOAuth.useMutation();

  return {
    deleteMcpServer: (name) => deleteMutation.mutateAsync({ name }),
    setMcpServer: (mcpServer) => setMutation.mutateAsync({ mcpServer }),
    startMcpOAuth: (name) => startOAuthMutation.mutateAsync({ name }),
    disconnectMcpOAuth: (name) => disconnectOAuthMutation.mutateAsync({ name }),
    validateMcpServer: (name) => validateMutation.mutateAsync({ name }),
  };
}

export function GlobalEnvVarsCard() {
  const { data, isLoading, refetch } = trpc.globalSettings.getWithSettings.useQuery();
  const mutations = useGlobalEnvVarMutations();

  return (
    <SettingsCard
      title="Global Environment Variables"
      description="Environment variables applied to all sessions. Per-repo variables with the same name will override these."
      isLoading={isLoading}
    >
      <EnvVarSection
        envVars={data?.envVars ?? []}
        mutations={mutations}
        onUpdate={refetch}
        emptyMessage="No global environment variables configured."
        deleteDescriptionPrefix="This will delete the global environment variable"
      />
    </SettingsCard>
  );
}

export function GlobalMcpServersCard() {
  const { data, isLoading, refetch } = trpc.globalSettings.getWithSettings.useQuery();
  const mutations = useGlobalMcpServerMutations();

  return (
    <SettingsCard
      title="Global MCP Servers"
      description="MCP servers available in all sessions. Per-repo servers with the same name will override these."
      isLoading={isLoading}
    >
      <McpServerSection
        mcpServers={data?.mcpServers ?? []}
        mutations={mutations}
        onUpdate={refetch}
        emptyMessage="No global MCP servers configured."
        deleteDescriptionPrefix="This will delete the global MCP server"
      />
    </SettingsCard>
  );
}
