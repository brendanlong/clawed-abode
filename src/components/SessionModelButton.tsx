'use client';

import { useState } from 'react';
import { Settings, Cpu } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ModelOverrideField } from '@/components/settings/shared/ModelOverrideField';
import { trpc } from '@/lib/trpc';

interface SessionModelButtonProps {
  sessionId: string;
  /** The session's current per-session model override, or null when none is set. */
  claudeModel: string | null;
}

/**
 * Per-session gear button in the session header. Opens a panel to view/change the
 * session's Claude model override, which takes precedence over the repo/global/env
 * model (see resolveClaudeModel) and persists on the session row.
 */
export function SessionModelButton({ sessionId, claudeModel }: SessionModelButtonProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const { data: globalSettings } = trpc.globalSettings.get.useQuery();

  const mutation = trpc.sessions.setModel.useMutation({
    onSuccess: () => {
      void utils.sessions.get.invalidate({ sessionId });
    },
    onError: (err) => setError(err.message),
  });

  const fallbackModel =
    globalSettings?.claudeModel ?? globalSettings?.defaultClaudeModel ?? 'opus[1m]';

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
              onSave={(model, onSuccess) => {
                setError(null);
                mutation.mutate({ sessionId, claudeModel: model }, { onSuccess });
              }}
              isPending={mutation.isPending}
              error={error}
              setButtonLabel="Set Model"
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
