'use client';

import { trpc } from '@/lib/trpc';
import {
  SETTING_SOURCES,
  type SettingSource,
  type SettingSourceFlags,
} from '@/lib/setting-sources';
import { SettingsCard } from '../shared/SettingsCard';
import { SwitchSetting } from '../shared/SwitchSetting';

const SETTING_SOURCE_LABELS: Record<SettingSource, { title: string; description: string }> = {
  user: {
    title: 'User',
    description: '~/.claude — the home directory of the account running the app.',
  },
  project: {
    title: 'Project',
    description: '<workspace>/.claude — config committed to the checked-out repository.',
  },
  local: {
    title: 'Local',
    description: '<workspace>/.claude/settings.local.json — uncommitted local overrides.',
  },
};

export function SettingSourcesCard({
  current,
  onUpdate,
}: {
  current: SettingSourceFlags;
  onUpdate: () => void;
}) {
  const mutation = trpc.globalSettings.setSettingSources.useMutation({ onSuccess: onUpdate });

  return (
    <SettingsCard
      title="Load Claude Settings From"
      description={
        <>
          Which scopes Claude Code loads settings, skills, hooks, and CLAUDE.md from for every
          session. Takes effect after a session is stopped and restarted. See the{' '}
          <a
            href="https://code.claude.com/docs/en/settings#available-scopes"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            settings scopes docs
          </a>
          .
        </>
      }
    >
      <div className="space-y-4">
        {SETTING_SOURCES.map((source) => (
          <SwitchSetting
            key={source}
            id={`setting-source-${source}`}
            title={SETTING_SOURCE_LABELS[source].title}
            description={SETTING_SOURCE_LABELS[source].description}
            checked={current[source]}
            onCheckedChange={(checked) => mutation.mutate({ ...current, [source]: checked })}
            disabled={mutation.isPending}
          />
        ))}
        {mutation.error && <p className="text-sm text-destructive">{mutation.error.message}</p>}
      </div>
    </SettingsCard>
  );
}
