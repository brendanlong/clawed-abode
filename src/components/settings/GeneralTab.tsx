'use client';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { CenteredSpinner } from '@/components/ui/spinner';
import { trpc } from '@/lib/trpc';
import { AdvisorModelCard, ClaudeModelCard } from './global/ModelCards';
import { ApiKeyCard } from './global/ApiKeyCard';
import {
  DefaultPromptCard,
  SystemPromptAppendCard,
  SystemPromptOverrideCard,
} from './global/PromptCards';
import { SettingSourcesCard } from './global/SettingSourcesCard';
import { BuiltinToolsCard } from './global/BuiltinToolsCard';
import { RateLimitPauseCard } from './global/RateLimitPauseCard';
import { GlobalEnvVarsCard, GlobalMcpServersCard } from './global/ScopedSettingsCards';

export function GeneralTab() {
  const { data: settings, error, refetch } = trpc.globalSettings.get.useQuery();
  const { data: defaultPromptData } = trpc.globalSettings.getDefaultSystemPrompt.useQuery();
  const defaultPrompt = defaultPromptData?.defaultSystemPrompt ?? '';

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }

  if (!settings) {
    return <CenteredSpinner />;
  }

  return (
    <div className="space-y-6">
      <ClaudeModelCard settings={settings} onUpdate={refetch} />
      <AdvisorModelCard settings={settings} onUpdate={refetch} />
      <ApiKeyCard
        hasDbKey={settings.hasClaudeApiKey}
        hasEnvKey={settings.hasEnvApiKey}
        onUpdate={refetch}
      />
      <SystemPromptOverrideCard
        currentOverride={settings.systemPromptOverride}
        overrideEnabled={settings.systemPromptOverrideEnabled}
        defaultPrompt={defaultPrompt}
        onUpdate={refetch}
      />
      <SystemPromptAppendCard currentAppend={settings.systemPromptAppend} onUpdate={refetch} />
      <SettingSourcesCard current={settings.settingSources} onUpdate={refetch} />
      <BuiltinToolsCard
        builtinToolsEnabled={settings.builtinToolsEnabled}
        sessionToolsEnabled={settings.sessionToolsEnabled}
        onUpdate={refetch}
      />
      <RateLimitPauseCard />
      <GlobalEnvVarsCard />
      <GlobalMcpServersCard />
      <DefaultPromptCard defaultPrompt={defaultPrompt} />
    </div>
  );
}
