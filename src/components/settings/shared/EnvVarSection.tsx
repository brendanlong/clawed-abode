'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Eye, EyeOff } from 'lucide-react';
import { SettingsListEditor, type SettingsScope } from './SettingsListEditor';
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
  const [revealedSecrets, setRevealedSecrets] = useState<ReadonlyMap<string, string>>(new Map());
  const [loadingSecret, setLoadingSecret] = useState<string | null>(null);

  const toggleSecretVisibility = async (name: string) => {
    if (revealedSecrets.has(name)) {
      setRevealedSecrets((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
      return;
    }
    setLoadingSecret(name);
    try {
      const { value } = await mutations.getSecretValue(name);
      setRevealedSecrets((prev) => new Map(prev).set(name, value));
    } catch {
      // Stays masked; the toggle can be retried.
    } finally {
      setLoadingSecret(null);
    }
  };

  return (
    <SettingsListEditor
      title="Environment Variables"
      itemNoun="environment variable"
      scope={scope}
      items={envVars}
      onDelete={mutations.deleteEnvVar}
      onUpdate={onUpdate}
      renderItem={(envVar) => {
        const revealed = revealedSecrets.has(envVar.name);
        return (
          <>
            <div className="font-mono text-sm">{envVar.name}</div>
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              {envVar.isSecret ? (
                <>
                  <span>{revealed ? revealedSecrets.get(envVar.name) : '••••••••'}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0"
                    onClick={() => toggleSecretVisibility(envVar.name)}
                    disabled={loadingSecret === envVar.name}
                    aria-label={revealed ? 'Hide value' : 'Show value'}
                  >
                    {loadingSecret === envVar.name ? (
                      <Spinner size="sm" className="h-3 w-3" />
                    ) : revealed ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                  </Button>
                </>
              ) : (
                <span className="truncate">{envVar.value}</span>
              )}
            </div>
          </>
        );
      }}
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
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      setError(
        'Name must start with a letter or underscore and contain only alphanumeric characters and underscores'
      );
      return;
    }

    if (!value && !keepsStoredSecret(existingEnvVar, isSecret)) {
      setError('Value is required');
      return;
    }

    setError(null);
    setIsPending(true);
    try {
      // An empty value for a secret is the server's "keep the stored ciphertext"
      // protocol — never substitute `existingEnvVar.value`, which is the mask.
      await setEnvVar({ name, value, isSecret });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setIsPending(false);
    }
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

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? <Spinner size="sm" /> : existingEnvVar ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
