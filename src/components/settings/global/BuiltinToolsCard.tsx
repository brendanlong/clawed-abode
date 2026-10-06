'use client';

import { trpc } from '@/lib/trpc';
import { SettingsCard } from '../shared/SettingsCard';
import { SwitchSetting } from '../shared/SwitchSetting';

export function BuiltinToolsCard({
  builtinToolsEnabled,
  sessionToolsEnabled,
  onUpdate,
}: {
  builtinToolsEnabled: boolean;
  sessionToolsEnabled: boolean;
  onUpdate: () => void;
}) {
  const mutation = trpc.globalSettings.update.useMutation({ onSuccess: onUpdate });

  return (
    <SettingsCard
      title="Built-in Tools"
      description="Tools this app gives every agent through its own MCP server. Takes effect after a session is stopped and restarted."
    >
      <div className="space-y-4">
        <SwitchSetting
          id="builtin-tools"
          title="Enable built-in tools"
          description="Lets agents rename their own session (they're asked to when it has the default name) and look up other sessions' addresses for messaging."
          checked={builtinToolsEnabled}
          onCheckedChange={(checked) => mutation.mutate({ builtinToolsEnabled: checked })}
          disabled={mutation.isPending}
        />
        <SwitchSetting
          id="session-tools"
          title="Session management"
          description="Also lets agents create, read, and stop your other sessions. They're told to do this only when you ask. Sessions an agent creates never get these tools."
          checked={builtinToolsEnabled && sessionToolsEnabled}
          onCheckedChange={(checked) => mutation.mutate({ sessionToolsEnabled: checked })}
          disabled={mutation.isPending || !builtinToolsEnabled}
        />
        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
      </div>
    </SettingsCard>
  );
}
