'use client';

import { Spinner } from '@/components/ui/spinner';
import { trpc } from '@/lib/trpc';
import { DEFAULT_SETTING_SOURCE_FLAGS } from '@/lib/setting-sources';
import { AdvisorModelCard, ClaudeModelCard } from './global/ModelCards';
import { ApiKeyCard } from './global/ApiKeyCard';
import {
  DefaultPromptCard,
  SystemPromptAppendCard,
  SystemPromptOverrideCard,
} from './global/PromptCards';
import { SettingSourcesCard } from './global/SettingSourcesCard';
import { GlobalEnvVarsCard, GlobalMcpServersCard } from './global/ScopedSettingsCards';

export function GeneralTab() {
  const { data: settings, isLoading, refetch } = trpc.globalSettings.get.useQuery();
  const { data: defaultPromptData } = trpc.globalSettings.getDefaultSystemPrompt.useQuery();
  const defaultPrompt = defaultPromptData?.defaultSystemPrompt ?? '';

  if (isLoading || !settings) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
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
      <SettingSourcesCard
        current={settings.settingSources ?? DEFAULT_SETTING_SOURCE_FLAGS}
        onUpdate={refetch}
      />
      <GlobalEnvVarsCard />
      <GlobalMcpServersCard />
      <DefaultPromptCard defaultPrompt={defaultPrompt} />
    </div>
  );
}
