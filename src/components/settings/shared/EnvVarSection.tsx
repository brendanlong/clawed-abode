'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Plus, Trash2, Eye, EyeOff } from 'lucide-react';
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
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [revealedSecrets, setRevealedSecrets] = useState<Map<string, string>>(new Map());
  const [loadingSecret, setLoadingSecret] = useState<string | null>(null);

  const toggleSecretVisibility = async (name: string) => {
    if (revealedSecrets.has(name)) {
      setRevealedSecrets((prev) => {
        const next = new Map(prev);
        next.delete(name);
        return next;
      });
    } else {
      setLoadingSecret(name);
      try {
        const result = await mutations.getSecretValue(name);
        setRevealedSecrets((prev) => {
          const next = new Map(prev);
          next.set(name, result.value);
          return next;
        });
      } finally {
        setLoadingSecret(null);
      }
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await mutations.deleteEnvVar(deleteTarget);
      setDeleteTarget(null);
      onUpdate();
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Environment Variables</h3>
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Add
        </Button>
      </div>

      {envVars.length === 0 && !showForm ? (
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
                        {revealedSecrets.has(envVar.name)
                          ? revealedSecrets.get(envVar.name)
                          : '••••••••'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={() => toggleSecretVisibility(envVar.name)}
                        disabled={loadingSecret === envVar.name}
                      >
                        {loadingSecret === envVar.name ? (
                          <Spinner size="sm" className="h-3 w-3" />
                        ) : revealedSecrets.has(envVar.name) ? (
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
              <Button variant="ghost" size="sm" onClick={() => setEditingId(envVar.id)}>
                Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDeleteTarget(envVar.name)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(showForm || editingId) && (
        <EnvVarForm
          existingEnvVar={editingId ? envVars.find((e) => e.id === editingId) : undefined}
          onClose={() => {
            setShowForm(false);
            setEditingId(null);
          }}
          onSuccess={() => {
            setShowForm(false);
            setEditingId(null);
            onUpdate();
          }}
          setEnvVar={mutations.setEnvVar}
          idPrefix={idPrefix}
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete environment variable?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteDescriptionPrefix} <strong>{deleteTarget}</strong>.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const [name, setName] = useState(existingEnvVar?.name ?? '');
  const [value, setValue] = useState(existingEnvVar?.isSecret ? '' : (existingEnvVar?.value ?? ''));
  const [isSecret, setIsSecret] = useState(existingEnvVar?.isSecret ?? false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      setError(
        'Name must start with a letter or underscore and contain only alphanumeric characters and underscores'
      );
      return;
    }

    if (!existingEnvVar?.isSecret && !value) {
      setError('Value is required');
      return;
    }

    setIsPending(true);
    try {
      await setEnvVar({
        name,
        value: existingEnvVar?.isSecret && !value ? existingEnvVar.value : value,
        isSecret,
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 p-4 border rounded-md">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="MY_API_KEY"
          disabled={!!existingEnvVar}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-value`}>Value</Label>
        <Input
          id={`${idPrefix}-value`}
          type={isSecret ? 'password' : 'text'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={existingEnvVar?.isSecret ? '(unchanged)' : 'Enter value'}
        />
      </div>

      <div className="flex items-center gap-2">
        <Switch id={`${idPrefix}-secret`} checked={isSecret} onCheckedChange={setIsSecret} />
        <Label htmlFor={`${idPrefix}-secret`}>Secret (encrypted at rest)</Label>
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
