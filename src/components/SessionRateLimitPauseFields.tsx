'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { trpc } from '@/lib/trpc';
import { MAX_PAUSE_THRESHOLD, MIN_PAUSE_THRESHOLD } from '@/lib/rate-limit';

/** How this session decides whether to pause, as the three-way control shows it. */
type PauseMode = 'inherit' | 'on' | 'off';

const MODE_TO_ENABLED: Record<PauseMode, boolean | null> = {
  inherit: null,
  on: true,
  off: false,
};

function modeFor(enabled: boolean | null): PauseMode {
  if (enabled === null) return 'inherit';
  return enabled ? 'on' : 'off';
}

interface SessionRateLimitPauseFieldsProps {
  sessionId: string;
  rateLimitPauseEnabled: boolean | null;
  rateLimitPauseThreshold: number | null;
}

/**
 * Per-session overrides for the rate-limit pause, so low-priority work can park at
 * 50% of the 5-hour window while urgent work runs on past the limit. Each field
 * inherits the global default independently.
 */
export function SessionRateLimitPauseFields({
  sessionId,
  rateLimitPauseEnabled,
  rateLimitPauseThreshold,
}: SessionRateLimitPauseFieldsProps) {
  const utils = trpc.useUtils();
  const { data: status } = trpc.rateLimit.getStatus.useQuery();
  const [draft, setDraft] = useState<{ enabled: boolean | null; threshold: number | null } | null>(
    null
  );

  const mutation = trpc.sessions.setRateLimitPause.useMutation({
    onSuccess: () => {
      setDraft(null);
      void utils.sessions.get.invalidate({ sessionId });
      void utils.claude.getRateLimitHold.invalidate({ sessionId });
    },
  });

  const saved = { enabled: rateLimitPauseEnabled, threshold: rateLimitPauseThreshold };
  const value = draft ?? saved;
  const dirty =
    draft !== null && (draft.enabled !== saved.enabled || draft.threshold !== saved.threshold);
  const globalThreshold = status?.policy.threshold ?? MAX_PAUSE_THRESHOLD;
  const effectiveThreshold = value.threshold ?? globalThreshold;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="session-pause-mode">Pause on usage limits</Label>
        <Select
          value={modeFor(value.enabled)}
          onValueChange={(mode) =>
            setDraft({ ...value, enabled: MODE_TO_ENABLED[mode as PauseMode] })
          }
        >
          <SelectTrigger id="session-pause-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">
              Use the global default ({status?.policy.enabled ? 'pause' : 'keep working'})
            </SelectItem>
            <SelectItem value="on">Pause and queue work until the window resets</SelectItem>
            <SelectItem value="off">Keep working (may fail, or spend overage credits)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="session-pause-threshold">
          Pause at {effectiveThreshold}% of the 5-hour window
          {value.threshold === null && ' (global default)'}
        </Label>
        <Slider
          id="session-pause-threshold"
          min={MIN_PAUSE_THRESHOLD}
          max={MAX_PAUSE_THRESHOLD}
          step={1}
          value={[effectiveThreshold]}
          onValueChange={([threshold]) => setDraft({ ...value, threshold })}
        />
        {value.threshold !== null && (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={() => setDraft({ ...value, threshold: null })}
          >
            Use the global default
          </Button>
        )}
      </div>

      {dirty && (
        <div className="flex gap-2">
          <Button
            onClick={() => mutation.mutate({ sessionId, ...value })}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
