import { describe, it, expect } from 'vitest';
import {
  envVarSectionReducer,
  initialEnvVarSectionState,
  envVarFormReducer,
  createInitialEnvVarFormState,
} from './env-var-reducer';
import type { EnvVarSectionState, EnvVarFormState } from './env-var-reducer';

describe('envVarSectionReducer', () => {
  describe('form visibility', () => {
    it('opens the form', () => {
      const result = envVarSectionReducer(initialEnvVarSectionState, { type: 'openForm' });
      expect(result.showForm).toBe(true);
    });

    it('starts editing by id', () => {
      const result = envVarSectionReducer(initialEnvVarSectionState, {
        type: 'startEditing',
        id: 'env-1',
      });
      expect(result.editingId).toBe('env-1');
    });

    it('closes the form and clears editingId', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        showForm: true,
        editingId: 'env-1',
      };
      const result = envVarSectionReducer(state, { type: 'closeForm' });
      expect(result.showForm).toBe(false);
      expect(result.editingId).toBeNull();
    });

    it('formSuccess closes form and clears editingId', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        showForm: true,
        editingId: 'env-1',
      };
      const result = envVarSectionReducer(state, { type: 'formSuccess' });
      expect(result.showForm).toBe(false);
      expect(result.editingId).toBeNull();
    });
  });

  describe('delete flow', () => {
    it('sets delete target', () => {
      const result = envVarSectionReducer(initialEnvVarSectionState, {
        type: 'setDeleteTarget',
        name: 'MY_VAR',
      });
      expect(result.deleteTarget).toBe('MY_VAR');
    });

    it('clears delete target', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        deleteTarget: 'MY_VAR',
      };
      const result = envVarSectionReducer(state, { type: 'setDeleteTarget', name: null });
      expect(result.deleteTarget).toBeNull();
    });

    it('starts deleting', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        deleteTarget: 'MY_VAR',
      };
      const result = envVarSectionReducer(state, { type: 'startDeleting' });
      expect(result.isDeleting).toBe(true);
    });

    it('finishes deleting and clears target', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        isDeleting: true,
        deleteTarget: 'MY_VAR',
      };
      const result = envVarSectionReducer(state, { type: 'finishDeleting' });
      expect(result.isDeleting).toBe(false);
      expect(result.deleteTarget).toBeNull();
    });
  });

  describe('secret visibility', () => {
    it('starts loading a secret', () => {
      const result = envVarSectionReducer(initialEnvVarSectionState, {
        type: 'startLoadingSecret',
        name: 'API_KEY',
      });
      expect(result.loadingSecret).toBe('API_KEY');
    });

    it('reveals a secret and clears loading state', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        loadingSecret: 'API_KEY',
      };
      const result = envVarSectionReducer(state, {
        type: 'revealSecret',
        name: 'API_KEY',
        value: 'secret-value',
      });
      expect(result.revealedSecrets.get('API_KEY')).toBe('secret-value');
      expect(result.loadingSecret).toBeNull();
    });

    it('hides a secret', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        revealedSecrets: new Map([['API_KEY', 'secret-value']]),
      };
      const result = envVarSectionReducer(state, { type: 'hideSecret', name: 'API_KEY' });
      expect(result.revealedSecrets.has('API_KEY')).toBe(false);
    });

    it('finishes loading secret without revealing', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        loadingSecret: 'API_KEY',
      };
      const result = envVarSectionReducer(state, { type: 'finishLoadingSecret' });
      expect(result.loadingSecret).toBeNull();
    });

    it('preserves other revealed secrets when revealing a new one', () => {
      const state: EnvVarSectionState = {
        ...initialEnvVarSectionState,
        revealedSecrets: new Map([['EXISTING', 'old-value']]),
        loadingSecret: 'NEW_KEY',
      };
      const result = envVarSectionReducer(state, {
        type: 'revealSecret',
        name: 'NEW_KEY',
        value: 'new-value',
      });
      expect(result.revealedSecrets.get('EXISTING')).toBe('old-value');
      expect(result.revealedSecrets.get('NEW_KEY')).toBe('new-value');
    });
  });
});

describe('envVarFormReducer', () => {
  describe('createInitialEnvVarFormState', () => {
    it('creates empty state when no existing env var', () => {
      const state = createInitialEnvVarFormState();
      expect(state).toEqual({
        name: '',
        value: '',
        isSecret: false,
        error: null,
        isPending: false,
      });
    });

    it('populates from existing non-secret env var', () => {
      const state = createInitialEnvVarFormState({
        name: 'MY_VAR',
        value: 'my-value',
        isSecret: false,
      });
      expect(state.name).toBe('MY_VAR');
      expect(state.value).toBe('my-value');
      expect(state.isSecret).toBe(false);
    });

    it('clears value for existing secret env var', () => {
      const state = createInitialEnvVarFormState({
        name: 'SECRET_VAR',
        value: 'encrypted-value',
        isSecret: true,
      });
      expect(state.name).toBe('SECRET_VAR');
      expect(state.value).toBe('');
      expect(state.isSecret).toBe(true);
    });
  });

  describe('field updates', () => {
    it('sets name', () => {
      const state = createInitialEnvVarFormState();
      const result = envVarFormReducer(state, { type: 'setName', name: 'NEW_NAME' });
      expect(result.name).toBe('NEW_NAME');
    });

    it('sets value', () => {
      const state = createInitialEnvVarFormState();
      const result = envVarFormReducer(state, { type: 'setValue', value: 'new-value' });
      expect(result.value).toBe('new-value');
    });

    it('sets isSecret', () => {
      const state = createInitialEnvVarFormState();
      const result = envVarFormReducer(state, { type: 'setIsSecret', isSecret: true });
      expect(result.isSecret).toBe(true);
    });

    it('sets error', () => {
      const state = createInitialEnvVarFormState();
      const result = envVarFormReducer(state, { type: 'setError', error: 'Something went wrong' });
      expect(result.error).toBe('Something went wrong');
    });

    it('clears error', () => {
      const state: EnvVarFormState = { ...createInitialEnvVarFormState(), error: 'old error' };
      const result = envVarFormReducer(state, { type: 'setError', error: null });
      expect(result.error).toBeNull();
    });
  });

  describe('submit flow', () => {
    it('startSubmit clears error and sets isPending', () => {
      const state: EnvVarFormState = {
        ...createInitialEnvVarFormState(),
        error: 'previous error',
      };
      const result = envVarFormReducer(state, { type: 'startSubmit' });
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(true);
    });

    it('submitError sets error and clears isPending', () => {
      const state: EnvVarFormState = { ...createInitialEnvVarFormState(), isPending: true };
      const result = envVarFormReducer(state, { type: 'submitError', error: 'Failed to save' });
      expect(result.error).toBe('Failed to save');
      expect(result.isPending).toBe(false);
    });

    it('finishSubmit clears isPending', () => {
      const state: EnvVarFormState = { ...createInitialEnvVarFormState(), isPending: true };
      const result = envVarFormReducer(state, { type: 'finishSubmit' });
      expect(result.isPending).toBe(false);
    });
  });
});
