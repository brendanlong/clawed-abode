'use client';

import { trpc } from '@/lib/trpc';
import { SettingsCard } from '../shared/SettingsCard';
import { SwitchSetting } from '../shared/SwitchSetting';

export function BuiltinToolsCard({
  builtinToolsEnabled,
  onUpdate,
}: {
  builtinToolsEnabled: boolean;
  onUpdate: () => void;
}) {
  const mutation = trpc.globalSettings.update.useMutation({ onSuccess: onUpdate });

  return (
    <SettingsCard
      title="Built-in Tools"
      description="Tools this app gives every agent through its own MCP server. A change restarts each session's agent (resuming its conversation) once it's idle."
    >
      <div className="space-y-4">
        <SwitchSetting
          id="builtin-tools"
          title="Enable built-in tools"
          description="Lets agents rename their own session (they're asked to when it has the default name) and look up other sessions' addresses for messaging. Session management is turned on per session, in the new-session form or session settings."
          checked={builtinToolsEnabled}
          onCheckedChange={(checked) => mutation.mutate({ builtinToolsEnabled: checked })}
          disabled={mutation.isPending}
        />
        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
      </div>
    </SettingsCard>
  );
}
