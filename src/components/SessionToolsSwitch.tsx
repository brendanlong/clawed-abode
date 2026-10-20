'use client';

import { SwitchSetting } from '@/components/settings/shared/SwitchSetting';
import { trpc } from '@/lib/trpc';

/** The per-session switch for the session-management tools (doc/settings.md "Built-in Tools"). */
export function SessionToolsSwitch({
  checked,
  pending,
  onCheckedChange,
}: {
  checked: boolean;
  pending?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { data: globalSettings } = trpc.globalSettings.get.useQuery();
  const builtinToolsEnabled = globalSettings?.builtinToolsEnabled ?? true;

  return (
    <SwitchSetting
      id="session-tools"
      title="Session management tools"
      description={
        builtinToolsEnabled
          ? "Lets this session's agent create, read, and stop your other sessions. It's told to do this only when you ask. Sessions it creates start without these tools."
          : 'Needs built-in tools, which are turned off in global settings.'
      }
      checked={builtinToolsEnabled && checked}
      onCheckedChange={onCheckedChange}
      disabled={pending || !builtinToolsEnabled}
    />
  );
}
