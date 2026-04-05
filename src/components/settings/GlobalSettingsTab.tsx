'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { trpc } from '@/lib/trpc';
import { EnvVarSection } from './shared/EnvVarSection';
import { McpServerSection } from './shared/McpServerSection';
import type { EnvVarMutations } from './shared/EnvVarSection';
import type { McpServerMutations } from './shared/McpServerSection';

function useGlobalEnvVarMutations(onUpdate: () => void): EnvVarMutations {
  const utils = trpc.useUtils();
  const deleteMutation = trpc.globalSettings.deleteEnvVar.useMutation({ onSuccess: onUpdate });
  const setMutation = trpc.globalSettings.setEnvVar.useMutation();

  return {
    deleteEnvVar: async (name) => {
      await deleteMutation.mutateAsync({ name });
    },
    setEnvVar: async (envVar) => {
      await setMutation.mutateAsync({ envVar });
    },
    getSecretValue: async (name) => {
      return await utils.globalSettings.getEnvVarValue.fetch({ name });
    },
  };
}

function useGlobalMcpServerMutations(onUpdate: () => void): McpServerMutations {
  const deleteMutation = trpc.globalSettings.deleteMcpServer.useMutation({ onSuccess: onUpdate });
  const setMutation = trpc.globalSettings.setMcpServer.useMutation();
  const validateMutation = trpc.globalSettings.validateMcpServer.useMutation();

  return {
    deleteMcpServer: async (name) => {
      await deleteMutation.mutateAsync({ name });
    },
    setMcpServer: async (mcpServer) => {
      await setMutation.mutateAsync({ mcpServer });
    },
    validateMcpServer: async (name) => {
      return await validateMutation.mutateAsync({ name });
    },
  };
}

export function GlobalEnvVarsCard() {
  const { data, isLoading, refetch } = trpc.globalSettings.getWithSettings.useQuery();
  const mutations = useGlobalEnvVarMutations(refetch);

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
        <EnvVarSection
          envVars={data?.envVars ?? []}
          mutations={mutations}
          onUpdate={refetch}
          emptyMessage="No global environment variables configured."
          deleteDescriptionPrefix="This will delete the global environment variable"
          idPrefix="global-env"
        />
      </CardContent>
    </Card>
  );
}

export function GlobalMcpServersCard() {
  const { data, isLoading, refetch } = trpc.globalSettings.getWithSettings.useQuery();
  const mutations = useGlobalMcpServerMutations(refetch);

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
        <McpServerSection
          mcpServers={data?.mcpServers ?? []}
          mutations={mutations}
          onUpdate={refetch}
          emptyMessage="No global MCP servers configured."
          deleteDescriptionPrefix="This will delete the global MCP server"
          idPrefix="global-mcp"
        />
      </CardContent>
    </Card>
  );
}

export function GlobalContainerCapabilitiesCard() {
  const { data, isLoading } = trpc.globalSettings.get.useQuery();
  const setPodman = trpc.globalSettings.setEnablePodman.useMutation();
  const setGpu = trpc.globalSettings.setEnableGpu.useMutation();
  const utils = trpc.useUtils();

  const handleToggle = async (field: 'podman' | 'gpu', value: boolean) => {
    if (field === 'podman') {
      await setPodman.mutateAsync({ enablePodman: value });
    } else {
      await setGpu.mutateAsync({ enableGpu: value });
    }
    utils.globalSettings.get.invalidate();
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Container Capabilities</CardTitle>
          <CardDescription>
            Default capabilities for new sessions. Per-repo settings can override these.
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
        <CardTitle>Container Capabilities</CardTitle>
        <CardDescription>
          Default capabilities for new sessions. Per-repo settings can override these. Changes take
          effect on newly created or restarted sessions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>GPU Access</Label>
              <p className="text-sm text-muted-foreground">
                Pass NVIDIA GPU devices to containers via CDI. Required for GPU workloads.
              </p>
            </div>
            <Switch
              checked={data?.enableGpu ?? true}
              onCheckedChange={(checked) => handleToggle('gpu', checked)}
              disabled={setGpu.isPending}
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Podman Socket Access</Label>
              <p className="text-sm text-muted-foreground">
                Mount the host&apos;s Podman socket into containers, enabling docker/podman commands
                (e.g., docker compose).
              </p>
            </div>
            <Switch
              checked={data?.enablePodman ?? false}
              onCheckedChange={(checked) => handleToggle('podman', checked)}
              disabled={setPodman.isPending || !data?.hasPodmanSocket}
            />
          </div>
          <p className="text-sm text-destructive/80">
            Security warning: The Podman socket allows containers to create other containers with
            arbitrary host mounts. A compromised dependency could use this to access files belonging
            to the user running the service. Only enable for trusted repositories, and consider{' '}
            <a
              href="https://github.com/brendanlong/clawed-abode#running-as-a-dedicated-unprivileged-user"
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              running as a dedicated user
            </a>{' '}
            to limit blast radius.
          </p>
          {!data?.hasPodmanSocket && (
            <p className="text-sm text-muted-foreground italic">
              No Podman socket configured (PODMAN_SOCKET_PATH not set).
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
