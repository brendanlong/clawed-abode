'use client';

import { useReducer } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { Plus, Trash2, Eye, EyeOff } from 'lucide-react';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import {
  envVarSectionReducer,
  initialEnvVarSectionState,
  envVarFormReducer,
  createInitialEnvVarFormState,
} from './env-var-reducer';
import type { EnvVar } from '@/lib/settings-types';

export interface EnvVarMutations {
  deleteEnvVar: (name: string) => Promise<void>;
  setEnvVar: (envVar: { name: string; value: string; isSecret: boolean }) => Promise<void>;
  getSecretValue: (name: string) => Promise<{ value: string }>;
}

interface EnvVarSectionProps {
  envVars: EnvVar[];
  mutations: EnvVarMutations;
  onUpdate: () => void;
  emptyMessage?: string;
  deleteDescriptionPrefix?: string;
  idPrefix?: string;
}

export function EnvVarSection({
  envVars,
  mutations,
  onUpdate,
  emptyMessage = 'No environment variables configured.',
  deleteDescriptionPrefix = 'This will delete the environment variable',
  idPrefix = 'env',
}: EnvVarSectionProps) {
  const [state, dispatch] = useReducer(envVarSectionReducer, initialEnvVarSectionState);

  const toggleSecretVisibility = async (name: string) => {
    if (state.revealedSecrets.has(name)) {
      dispatch({ type: 'hideSecret', name });
    } else {
      dispatch({ type: 'startLoadingSecret', name });
      try {
        const result = await mutations.getSecretValue(name);
        dispatch({ type: 'revealSecret', name, value: result.value });
      } catch {
        dispatch({ type: 'finishLoadingSecret' });
      }
    }
  };

  const handleDelete = async () => {
    if (!state.deleteTarget) return;
    dispatch({ type: 'startDeleting' });
    try {
      await mutations.deleteEnvVar(state.deleteTarget);
      dispatch({ type: 'finishDeleting' });
      onUpdate();
    } catch {
      dispatch({ type: 'finishDeleting' });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Environment Variables</h3>
        <Button variant="outline" size="sm" onClick={() => dispatch({ type: 'openForm' })}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {envVars.length === 0 && !state.showForm ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <ul className="space-y-2">
          {envVars.map((envVar) => (
            <li key={envVar.id} className="flex items-center gap-2 p-2 rounded-md bg-muted/50">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-sm">{envVar.name}</div>
                <div className="text-xs text-muted-foreground flex items-center gap-1">
                  {envVar.isSecret ? (
                    <>
                      <span>
                        {state.revealedSecrets.has(envVar.name)
                          ? state.revealedSecrets.get(envVar.name)
                          : '••••••••'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={() => toggleSecretVisibility(envVar.name)}
                        disabled={state.loadingSecret === envVar.name}
                      >
                        {state.loadingSecret === envVar.name ? (
                          <Spinner size="sm" className="h-3 w-3" />
                        ) : state.revealedSecrets.has(envVar.name) ? (
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
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => dispatch({ type: 'startEditing', id: envVar.id })}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => dispatch({ type: 'setDeleteTarget', name: envVar.name })}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(state.showForm || state.editingId) && (
        <EnvVarForm
          existingEnvVar={
            state.editingId ? envVars.find((e) => e.id === state.editingId) : undefined
          }
          onClose={() => dispatch({ type: 'closeForm' })}
          onSuccess={() => {
            dispatch({ type: 'formSuccess' });
            onUpdate();
          }}
          setEnvVar={mutations.setEnvVar}
          idPrefix={idPrefix}
        />
      )}

      <DeleteConfirmDialog
        open={!!state.deleteTarget}
        onClose={() => dispatch({ type: 'setDeleteTarget', name: null })}
        onConfirm={handleDelete}
        title="Delete environment variable?"
        description={
          <>
            {deleteDescriptionPrefix} <strong>{state.deleteTarget}</strong>.
          </>
        }
        isPending={state.isDeleting}
      />
    </div>
  );
}

function EnvVarForm({
  existingEnvVar,
  onClose,
  onSuccess,
  setEnvVar,
  idPrefix,
}: {
  existingEnvVar?: EnvVar;
  onClose: () => void;
  onSuccess: () => void;
  setEnvVar: EnvVarMutations['setEnvVar'];
  idPrefix: string;
}) {
  const [form, dispatch] = useReducer(envVarFormReducer, existingEnvVar, (existing) =>
    createInitialEnvVarFormState(existing)
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.name.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      dispatch({
        type: 'setError',
        error:
          'Name must start with a letter or underscore and contain only alphanumeric characters and underscores',
      });
      return;
    }

    if (!existingEnvVar?.isSecret && !form.value) {
      dispatch({ type: 'setError', error: 'Value is required' });
      return;
    }

    dispatch({ type: 'startSubmit' });
    try {
      await setEnvVar({
        name: form.name,
        value: existingEnvVar?.isSecret && !form.value ? existingEnvVar.value : form.value,
        isSecret: form.isSecret,
      });
      onSuccess();
    } catch (err) {
      dispatch({
        type: 'submitError',
        error: err instanceof Error ? err.message : 'An error occurred',
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={form.name}
          onChange={(e) => dispatch({ type: 'setName', name: e.target.value.toUpperCase() })}
          placeholder="MY_API_KEY"
          disabled={!!existingEnvVar}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-value`}>Value</Label>
        <Input
          id={`${idPrefix}-value`}
          type={form.isSecret ? 'password' : 'text'}
          value={form.value}
          onChange={(e) => dispatch({ type: 'setValue', value: e.target.value })}
          placeholder={existingEnvVar?.isSecret ? '(unchanged)' : 'Enter value'}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch
          id={`${idPrefix}-secret`}
          checked={form.isSecret}
          onCheckedChange={(isSecret) => dispatch({ type: 'setIsSecret', isSecret })}
        />
        <Label htmlFor={`${idPrefix}-secret`}>Secret (encrypted at rest)</Label>
      </div>

      {form.error && <p className="text-sm text-destructive">{form.error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={form.isPending}>
          {form.isPending ? <Spinner size="sm" /> : existingEnvVar ? 'Update' : 'Add'}
        </Button>
      </div>
    </form>
  );
}
