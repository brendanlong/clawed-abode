'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { trpc } from '@/lib/trpc';
import { useNowTick } from '@/hooks/useNowTick';
import {
  describeLimitType,
  formatTimeUntil,
  MAX_PAUSE_THRESHOLD,
  MIN_PAUSE_THRESHOLD,
} from '@/lib/rate-limit';
import { SettingsCard } from '../shared/SettingsCard';
import { SwitchSetting } from '../shared/SwitchSetting';

/**
 * Global defaults for the subscription rate-limit pause, plus the live window
 * state they act on. Individual sessions can override both fields from the
 * session settings panel (see SessionSettingsButton).
 */
export function RateLimitPauseCard() {
  const now = useNowTick();
  const { data, refetch } = trpc.rateLimit.getStatus.useQuery();
  const [draft, setDraft] = useState<{ enabled: boolean; threshold: number } | null>(null);
  const mutation = trpc.rateLimit.setDefaults.useMutation({
    onSuccess: () => {
      setDraft(null);
      void refetch();
    },
  });

  if (!data) return null;
  const value = draft ?? data.policy;
  const dirty =
    draft !== null &&
    (draft.enabled !== data.policy.enabled || draft.threshold !== data.policy.threshold);

  return (
    <SettingsCard
      title="Pause on Usage Limits"
      description={
        'Park work instead of failing it when your Claude subscription window fills, then ' +
        'release it automatically when the window resets. Leave this off to keep working ' +
        'past the limit on overage credits.'
      }
    >
      <div className="space-y-6">
        <SwitchSetting
          id="rate-limit-pause-enabled"
          title="Pause sessions by default"
          description="Applies to every session that doesn't set its own preference."
          checked={value.enabled}
          onCheckedChange={(enabled) => setDraft({ ...value, enabled })}
        />

        <div className="space-y-2">
          <Label htmlFor="rate-limit-pause-threshold">
            Pause at {value.threshold}% of the 5-hour window
          </Label>
          <Slider
            id="rate-limit-pause-threshold"
            min={MIN_PAUSE_THRESHOLD}
            max={MAX_PAUSE_THRESHOLD}
            step={1}
            value={[value.threshold]}
            onValueChange={([threshold]) => setDraft({ ...value, threshold })}
          />
          <p className="text-muted-foreground text-sm">
            Pausing before the window is exhausted avoids turns being cut off mid-task. Weekly
            limits ignore this threshold and only pause once the API actually refuses a request, so
            a week&apos;s allowance is always spent in full. 100% is effectively &ldquo;only when
            refused&rdquo;.
          </p>
        </div>

        {dirty && (
          <div className="flex gap-2">
            <Button onClick={() => mutation.mutate(value)} disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        )}

        {data.readings.length > 0 && (
          <div className="space-y-1 border-t pt-4 text-sm">
            <p className="font-medium">Current usage</p>
            {data.readings.map((reading) => (
              <p key={reading.limitType} className="text-muted-foreground">
                {describeLimitType(reading.limitType)}:{' '}
                {reading.rejected
                  ? 'used up'
                  : reading.utilization === null
                    ? 'unknown'
                    : `${Math.round(reading.utilization)}% used`}
                , resets {formatTimeUntil(reading.resetsAtMs, now)}
              </p>
            ))}
            {data.queuedPrompts > 0 && (
              <p className="text-muted-foreground">
                {data.queuedPrompts} prompt{data.queuedPrompts === 1 ? '' : 's'} waiting across all
                sessions.
              </p>
            )}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
