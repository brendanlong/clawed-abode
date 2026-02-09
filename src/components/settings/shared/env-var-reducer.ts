// -- EnvVarSection (list management) reducer --

export interface EnvVarSectionState {
  showForm: boolean;
  editingId: string | null;
  deleteTarget: string | null;
  isDeleting: boolean;
  revealedSecrets: Map<string, string>;
  loadingSecret: string | null;
}

export type EnvVarSectionAction =
  | { type: 'openForm' }
  | { type: 'startEditing'; id: string }
  | { type: 'closeForm' }
  | { type: 'formSuccess' }
  | { type: 'setDeleteTarget'; name: string | null }
  | { type: 'startDeleting' }
  | { type: 'finishDeleting' }
  | { type: 'startLoadingSecret'; name: string }
  | { type: 'revealSecret'; name: string; value: string }
  | { type: 'hideSecret'; name: string }
  | { type: 'finishLoadingSecret' };

export const initialEnvVarSectionState: EnvVarSectionState = {
  showForm: false,
  editingId: null,
  deleteTarget: null,
  isDeleting: false,
  revealedSecrets: new Map(),
  loadingSecret: null,
};

export function envVarSectionReducer(
  state: EnvVarSectionState,
  action: EnvVarSectionAction
): EnvVarSectionState {
  switch (action.type) {
    case 'openForm':
      return { ...state, showForm: true };
    case 'startEditing':
      return { ...state, editingId: action.id };
    case 'closeForm':
      return { ...state, showForm: false, editingId: null };
    case 'formSuccess':
      return { ...state, showForm: false, editingId: null };
    case 'setDeleteTarget':
      return { ...state, deleteTarget: action.name };
    case 'startDeleting':
      return { ...state, isDeleting: true };
    case 'finishDeleting':
      return { ...state, isDeleting: false, deleteTarget: null };
    case 'startLoadingSecret':
      return { ...state, loadingSecret: action.name };
    case 'revealSecret': {
      const next = new Map(state.revealedSecrets);
      next.set(action.name, action.value);
      return { ...state, revealedSecrets: next, loadingSecret: null };
    }
    case 'hideSecret': {
      const next = new Map(state.revealedSecrets);
      next.delete(action.name);
      return { ...state, revealedSecrets: next };
    }
    case 'finishLoadingSecret':
      return { ...state, loadingSecret: null };
  }
}

// -- EnvVarForm reducer --

export interface EnvVarFormState {
  name: string;
  value: string;
  isSecret: boolean;
  error: string | null;
  isPending: boolean;
}

export type EnvVarFormAction =
  | { type: 'setName'; name: string }
  | { type: 'setValue'; value: string }
  | { type: 'setIsSecret'; isSecret: boolean }
  | { type: 'setError'; error: string | null }
  | { type: 'startSubmit' }
  | { type: 'submitError'; error: string }
  | { type: 'finishSubmit' };

export function createInitialEnvVarFormState(existing?: {
  name: string;
  value: string;
  isSecret: boolean;
}): EnvVarFormState {
  return {
    name: existing?.name ?? '',
    value: existing?.isSecret ? '' : (existing?.value ?? ''),
    isSecret: existing?.isSecret ?? false,
    error: null,
    isPending: false,
  };
}

export function envVarFormReducer(
  state: EnvVarFormState,
  action: EnvVarFormAction
): EnvVarFormState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.name };
    case 'setValue':
      return { ...state, value: action.value };
    case 'setIsSecret':
      return { ...state, isSecret: action.isSecret };
    case 'setError':
      return { ...state, error: action.error };
    case 'startSubmit':
      return { ...state, error: null, isPending: true };
    case 'submitError':
      return { ...state, error: action.error, isPending: false };
    case 'finishSubmit':
      return { ...state, isPending: false };
  }
}
