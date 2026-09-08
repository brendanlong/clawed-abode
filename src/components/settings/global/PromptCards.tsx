'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { trpc } from '@/lib/trpc';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { SettingsCard } from '../shared/SettingsCard';
import { EditableTextSetting } from '../shared/EditableTextSetting';

export function SystemPromptOverrideCard({
  currentOverride,
  overrideEnabled,
  defaultPrompt,
  onUpdate,
}: {
  currentOverride: string | null;
  overrideEnabled: boolean;
  defaultPrompt: string;
  onUpdate: () => void;
}) {
  const saveMutation = trpc.globalSettings.setSystemPromptOverride.useMutation({
    onSuccess: onUpdate,
  });
  const toggleMutation = trpc.globalSettings.toggleSystemPromptOverrideEnabled.useMutation({
    onSuccess: onUpdate,
  });

  return (
    <SettingsCard
      title="System Prompt Override"
      description="Replace the default system prompt with a custom one. When disabled, the built-in default will be used."
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="override-enabled"
            checked={overrideEnabled && currentOverride !== null}
            onCheckedChange={(enabled) => toggleMutation.mutate({ enabled })}
            disabled={toggleMutation.isPending || currentOverride === null}
          />
          <Label htmlFor="override-enabled">
            {currentOverride === null
              ? 'No override set'
              : overrideEnabled
                ? 'Override enabled'
                : 'Using default prompt'}
          </Label>
        </div>
        {toggleMutation.error && (
          <p className="text-sm text-destructive">{toggleMutation.error.message}</p>
        )}

        <EditableTextSetting
          value={currentOverride}
          onSave={(systemPromptOverride, onSuccess) =>
            saveMutation.mutate(
              {
                systemPromptOverride,
                systemPromptOverrideEnabled: overrideEnabled && systemPromptOverride !== null,
              },
              { onSuccess }
            )
          }
          mutation={saveMutation}
          placeholder="Enter your custom system prompt..."
          addLabel="Create Override"
          editLabel="Edit Override"
          emptyDraft={defaultPrompt}
          resetTo={{ label: 'Custom System Prompt', value: defaultPrompt }}
          textareaClassName="min-h-[200px]"
          previewClassName="max-h-[200px]"
        />
      </div>
    </SettingsCard>
  );
}

export function SystemPromptAppendCard({
  currentAppend,
  onUpdate,
}: {
  currentAppend: string | null;
  onUpdate: () => void;
}) {
  const mutation = trpc.globalSettings.setSystemPromptAppend.useMutation({ onSuccess: onUpdate });

  return (
    <SettingsCard
      title="Global System Prompt Append"
      description="Additional content appended to the system prompt for all sessions. This is added after the default/override prompt and before any per-repo prompts."
    >
      <EditableTextSetting
        value={currentAppend}
        onSave={(systemPromptAppend, onSuccess) =>
          mutation.mutate({ systemPromptAppend }, { onSuccess })
        }
        mutation={mutation}
        placeholder="Enter additional instructions to append to all sessions..."
        addLabel="Add Global Append"
        previewClassName="max-h-[150px]"
      />
    </SettingsCard>
  );
}

export function DefaultPromptCard({ defaultPrompt }: { defaultPrompt: string }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <SettingsCard
      title="Default System Prompt"
      description="The built-in system prompt used when no override is set. This ensures Claude follows the proper workflow for remote sessions."
    >
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-full justify-start">
            {isOpen ? (
              <ChevronDown className="h-4 w-4 mr-2" />
            ) : (
              <ChevronRight className="h-4 w-4 mr-2" />
            )}
            {isOpen ? 'Hide default prompt' : 'Show default prompt'}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 rounded-md bg-muted/50 p-3 max-h-[300px] overflow-y-auto">
            <pre className="text-sm whitespace-pre-wrap font-mono">{defaultPrompt}</pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </SettingsCard>
  );
}
