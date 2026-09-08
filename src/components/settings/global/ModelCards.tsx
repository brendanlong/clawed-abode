'use client';

import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@/server/routers';
import { trpc } from '@/lib/trpc';
import { DEFAULT_CLAUDE_MODEL } from '@/lib/claude-model';
import { SUGGESTED_ADVISOR_MODEL } from '@/lib/advisor';
import { SettingsCard } from '../shared/SettingsCard';
import { ModelOverrideField } from '../shared/ModelOverrideField';

type GlobalSettings = inferRouterOutputs<AppRouter>['globalSettings']['get'];

export function ClaudeModelCard({
  settings,
  onUpdate,
}: {
  settings: GlobalSettings;
  onUpdate: () => void;
}) {
  const mutation = trpc.globalSettings.setClaudeModel.useMutation({ onSuccess: onUpdate });

  return (
    <SettingsCard
      title="Claude Model"
      description="The Claude model used for all sessions. Overrides the CLAUDE_MODEL environment variable when set."
    >
      <ModelOverrideField
        currentModel={settings.claudeModel}
        defaultModel={settings.defaultClaudeModel ?? DEFAULT_CLAUDE_MODEL}
        onSave={(claudeModel, onSuccess) => mutation.mutate({ claudeModel }, { onSuccess })}
        mutation={mutation}
      />
    </SettingsCard>
  );
}

export function AdvisorModelCard({
  settings,
  onUpdate,
}: {
  settings: GlobalSettings;
  onUpdate: () => void;
}) {
  const mutation = trpc.globalSettings.setAdvisorModel.useMutation({ onSuccess: onUpdate });

  return (
    <SettingsCard
      title="Advisor Model"
      description="The model used by the server-side advisor tool, which Claude can consult for a second opinion during a session. Disabled by default — set a model to enable it for all sessions. Takes effect after a session is stopped and restarted."
    >
      <ModelOverrideField
        currentModel={settings.advisorModel}
        defaultModel={settings.suggestedAdvisorModel ?? SUGGESTED_ADVISOR_MODEL}
        emptyLabel="Disabled"
        emptyHint={null}
        setButtonLabel="Enable"
        clearButtonLabel="Disable"
        emptySavesDefault
        onSave={(advisorModel, onSuccess) => mutation.mutate({ advisorModel }, { onSuccess })}
        mutation={mutation}
      />
    </SettingsCard>
  );
}
