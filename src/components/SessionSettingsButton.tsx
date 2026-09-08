'use client';

import { useState } from 'react';
import { Settings, Cpu, PauseCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ModelOverrideField } from '@/components/settings/shared/ModelOverrideField';
import { SessionRateLimitPauseFields } from '@/components/SessionRateLimitPauseFields';
import { Separator } from '@/components/ui/separator';
import { trpc } from '@/lib/trpc';
import { fallbackClaudeModel } from '@/lib/claude-model';

interface SessionSettingsButtonProps {
  sessionId: string;
  /** The session's current per-session model override, or null when none is set. */
  claudeModel: string | null;
  /** Per-session rate-limit pause overrides; null on either field inherits the global default. */
  rateLimitPauseEnabled: boolean | null;
  rateLimitPauseThreshold: number | null;
}

/**
 * Per-session gear button in the session header. Opens a panel of overrides that
 * apply to this session alone and take precedence over the repo/global settings:
 * the Claude model (see resolveClaudeModel) and the rate-limit pause (see
 * resolvePausePolicy).
 */
export function SessionSettingsButton({
  sessionId,
  claudeModel,
  rateLimitPauseEnabled,
  rateLimitPauseThreshold,
}: SessionSettingsButtonProps) {
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();
  const { data: globalSettings } = trpc.globalSettings.get.useQuery();

  const mutation = trpc.sessions.setModel.useMutation({
    onSuccess: () => {
      void utils.sessions.get.invalidate({ sessionId });
    },
  });

  const fallbackModel = fallbackClaudeModel(globalSettings);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title="Session settings"
        className="shrink-0 h-8 w-8"
      >
        <Settings className="h-4 w-4" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Session Settings</SheetTitle>
            <SheetDescription>Settings that apply only to this session.</SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-4">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-medium">Claude Model</h3>
            </div>

            <p className="text-sm text-muted-foreground">
              Overrides the model for this session only. Takes precedence over the repo and global
              models. Applies to the next turn.
            </p>

            <ModelOverrideField
              currentModel={claudeModel}
              defaultModel={fallbackModel}
              onSave={(model, onSuccess) =>
                mutation.mutate({ sessionId, claudeModel: model }, { onSuccess })
              }
              mutation={mutation}
              setButtonLabel="Set Model"
            />

            <Separator />

            <div className="flex items-center gap-2">
              <PauseCircle className="h-4 w-4 text-muted-foreground" />
              <h3 className="font-medium">Usage Limits</h3>
            </div>

            <p className="text-sm text-muted-foreground">
              Whether this session parks its work when your subscription window fills, and how
              early. Lower the threshold for low-priority work you want to run on leftovers; turn
              pausing off for work that must not wait.
            </p>

            <SessionRateLimitPauseFields
              sessionId={sessionId}
              rateLimitPauseEnabled={rateLimitPauseEnabled}
              rateLimitPauseThreshold={rateLimitPauseThreshold}
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
