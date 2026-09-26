import { describe, it, expect } from 'vitest';
import {
  envVarSectionReducer,
  initialEnvVarSectionState,
  envVarFormReducer,
  createInitialEnvVarFormState,
} from './env-var-reducer';
import type { EnvVarSectionState, EnvVarFormState } from './env-var-reducer';

describe('envVarSectionReducer', () => {
  it('delegates shared list actions and preserves its own fields', () => {
    const state: EnvVarSectionState = { ...initialEnvVarSectionState, loadingSecret: 'API_KEY' };
    const result = envVarSectionReducer(state, { type: 'openForm' });
    expect(result).toEqual({ ...state, showForm: true });
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
  });
});
