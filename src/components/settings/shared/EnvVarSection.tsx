'use client';

import { useId, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Eye, EyeOff } from 'lucide-react';
import { SettingsListEditor, SettingsListRow, type SettingsScope } from './SettingsListEditor';
import { keepsStoredSecret } from '@/lib/key-value-entries';
import type { EnvVar } from '@/lib/settings-types';

export interface EnvVarMutations {
  deleteEnvVar: (name: string) => Promise<unknown>;
  setEnvVar: (envVar: { name: string; value: string; isSecret: boolean }) => Promise<unknown>;
  getSecretValue: (name: string) => Promise<{ value: string }>;
}

interface EnvVarSectionProps {
  envVars: EnvVar[];
  mutations: EnvVarMutations;
  onUpdate: () => void;
  scope: SettingsScope;
}

export function EnvVarSection({ envVars, mutations, onUpdate, scope }: EnvVarSectionProps) {
  return (
    <SettingsListEditor
      title="Environment Variables"
      itemNoun="environment variable"
      scope={scope}
      items={envVars}
      onDelete={mutations.deleteEnvVar}
      onUpdate={onUpdate}
      renderRow={(envVar, editorActions) => (
        <EnvVarRow
          envVar={envVar}
          editorActions={editorActions}
          getSecretValue={mutations.getSecretValue}
        />
      )}
      renderForm={({ existingItem, onClose, onSuccess }) => (
        <EnvVarForm
          existingEnvVar={existingItem}
          onClose={onClose}
          onSuccess={onSuccess}
          setEnvVar={mutations.setEnvVar}
        />
      )}
    />
  );
}

function EnvVarRow({
  envVar,
  editorActions,
  getSecretValue,
}: {
  envVar: EnvVar;
  editorActions: ReactNode;
  getSecretValue: EnvVarMutations['getSecretValue'];
}) {
  // A failed reveal just stays masked; the toggle can be retried.
  const reveal = useMutation({ mutationFn: () => getSecretValue(envVar.name) });
  const revealed = reveal.data?.value;

  return (
    <SettingsListRow editorActions={editorActions}>
      <div className="font-mono text-sm">{envVar.name}</div>
      <div className="text-xs text-muted-foreground flex items-center gap-1">
        {envVar.isSecret ? (
          <>
            <span>{revealed ?? '••••••••'}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 w-5 p-0"
              onClick={() => (revealed === undefined ? reveal.mutate() : reveal.reset())}
              disabled={reveal.isPending}
              aria-label={revealed === undefined ? 'Show value' : 'Hide value'}
            >
              {reveal.isPending ? (
                <Spinner size="sm" className="h-3 w-3" />
              ) : revealed === undefined ? (
                <Eye className="h-3 w-3" />
              ) : (
                <EyeOff className="h-3 w-3" />
              )}
            </Button>
          </>
        ) : (
          <span className="truncate">{envVar.value}</span>
        )}
      </div>
    </SettingsListRow>
  );
}

function EnvVarForm({
  existingEnvVar,
  onClose,
  onSuccess,
  setEnvVar,
}: {
  existingEnvVar?: EnvVar;
  onClose: () => void;
  onSuccess: () => void;
  setEnvVar: EnvVarMutations['setEnvVar'];
}) {
  const id = useId();
  const [name, setName] = useState(existingEnvVar?.name ?? '');
  // A stored secret arrives masked; start blank so an untouched field means "keep".
  const [value, setValue] = useState(existingEnvVar?.isSecret ? '' : (existingEnvVar?.value ?? ''));
  const [isSecret, setIsSecret] = useState(existingEnvVar?.isSecret ?? false);
  // Validation failures throw from mutationFn too, so `save.error` is the one error to show.
  const save = useMutation({
    mutationFn: async () => {
      if (!name.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
        throw new Error(
          'Name must start with a letter or underscore and contain only alphanumeric characters and underscores'
        );
      }
      if (!value && !keepsStoredSecret(existingEnvVar, isSecret)) {
        throw new Error('Value is required');
      }
      // An empty value for a secret is the server's "keep the stored ciphertext"
      // protocol — never substitute `existingEnvVar.value`, which is the mask.
      await setEnvVar({ name, value, isSecret });
    },
    onSuccess,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="MY_API_KEY"
          disabled={!!existingEnvVar}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${id}-value`}>Value</Label>
        <Input
          id={`${id}-value`}
          type={isSecret ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={keepsStoredSecret(existingEnvVar, isSecret) ? '(unchanged)' : 'Enter value'}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch id={`${id}-secret`} checked={isSecret} onCheckedChange={setIsSecret} />
        <Label htmlFor={`${id}-secret`}>Secret (encrypted at rest)</Label>
      </div>

      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? <Spinner size="sm" /> : existingEnvVar ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
