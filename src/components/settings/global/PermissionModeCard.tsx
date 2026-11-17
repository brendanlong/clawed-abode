'use client';

import type { AppPermissionMode } from '@/lib/permission-mode';
import { useUpdateGlobalSettings } from '../shared/useUpdateGlobalSettings';
import { SettingsCard } from '../shared/SettingsCard';
import { SwitchSetting } from '../shared/SwitchSetting';

export function PermissionModeCard({ permissionMode }: { permissionMode: AppPermissionMode }) {
  const mutation = useUpdateGlobalSettings();

  return (
    <SettingsCard
      title="Permissions"
      description="How agents' tool calls are approved. Changes apply to running sessions immediately."
    >
      <div className="space-y-4">
        <SwitchSetting
          id="auto-permission-mode"
          title="Auto mode"
          description="A classifier model approves or blocks each tool call, and asks you when it can't decide. Off approves every tool call without checking (bypass permissions)."
          checked={permissionMode === 'auto'}
          onCheckedChange={(checked) =>
            mutation.mutate({ permissionMode: checked ? 'auto' : 'bypassPermissions' })
          }
          disabled={mutation.isPending}
        />
        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
      </div>
    </SettingsCard>
  );
}
