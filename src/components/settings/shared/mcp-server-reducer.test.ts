import { describe, it, expect } from 'vitest';
import {
  mcpServerSectionReducer,
  initialMcpServerSectionState,
  mcpServerFormReducer,
  createInitialMcpServerFormState,
} from './mcp-server-reducer';
import type { McpServerSectionState, McpServerFormState } from './mcp-server-reducer';

describe('mcpServerSectionReducer', () => {
  describe('form visibility', () => {
    it('opens the form', () => {
      const result = mcpServerSectionReducer(initialMcpServerSectionState, { type: 'openForm' });
      expect(result.showForm).toBe(true);
    });

    it('starts editing by id', () => {
      const result = mcpServerSectionReducer(initialMcpServerSectionState, {
        type: 'startEditing',
        id: 'mcp-1',
      });
      expect(result.editingId).toBe('mcp-1');
    });

    it('closes the form and clears editingId', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        showForm: true,
        editingId: 'mcp-1',
      };
      const result = mcpServerSectionReducer(state, { type: 'closeForm' });
      expect(result.showForm).toBe(false);
      expect(result.editingId).toBeNull();
    });

    it('formSuccess closes form and clears editingId', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        showForm: true,
        editingId: 'mcp-1',
      };
      const result = mcpServerSectionReducer(state, { type: 'formSuccess' });
      expect(result.showForm).toBe(false);
      expect(result.editingId).toBeNull();
    });
  });

  describe('delete flow', () => {
    it('sets delete target', () => {
      const result = mcpServerSectionReducer(initialMcpServerSectionState, {
        type: 'setDeleteTarget',
        name: 'memory',
      });
      expect(result.deleteTarget).toBe('memory');
    });

    it('clears delete target', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        deleteTarget: 'memory',
      };
      const result = mcpServerSectionReducer(state, { type: 'setDeleteTarget', name: null });
      expect(result.deleteTarget).toBeNull();
    });

    it('starts deleting', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        deleteTarget: 'memory',
      };
      const result = mcpServerSectionReducer(state, { type: 'startDeleting' });
      expect(result.isDeleting).toBe(true);
    });

    it('finishes deleting and clears target', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        isDeleting: true,
        deleteTarget: 'memory',
      };
      const result = mcpServerSectionReducer(state, { type: 'finishDeleting' });
      expect(result.isDeleting).toBe(false);
      expect(result.deleteTarget).toBeNull();
    });
  });

  describe('validation', () => {
    it('starts validating a server', () => {
      const result = mcpServerSectionReducer(initialMcpServerSectionState, {
        type: 'startValidating',
        name: 'memory',
      });
      expect(result.validatingServer).toBe('memory');
    });

    it('sets validation result and clears validating state', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        validatingServer: 'memory',
      };
      const result = mcpServerSectionReducer(state, {
        type: 'setValidationResult',
        name: 'memory',
        result: { success: true, tools: ['tool1', 'tool2'] },
      });
      expect(result.validationResults.get('memory')).toEqual({
        success: true,
        tools: ['tool1', 'tool2'],
      });
      expect(result.validatingServer).toBeNull();
    });

    it('sets failed validation result', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        validatingServer: 'memory',
      };
      const result = mcpServerSectionReducer(state, {
        type: 'setValidationResult',
        name: 'memory',
        result: { success: false, error: 'Connection failed' },
      });
      expect(result.validationResults.get('memory')).toEqual({
        success: false,
        error: 'Connection failed',
      });
    });

    it('preserves other validation results when setting a new one', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        validationResults: new Map([['other', { success: true }]]),
        validatingServer: 'memory',
      };
      const result = mcpServerSectionReducer(state, {
        type: 'setValidationResult',
        name: 'memory',
        result: { success: true },
      });
      expect(result.validationResults.get('other')).toEqual({ success: true });
      expect(result.validationResults.get('memory')).toEqual({ success: true });
    });

    it('finishes validating without result', () => {
      const state: McpServerSectionState = {
        ...initialMcpServerSectionState,
        validatingServer: 'memory',
      };
      const result = mcpServerSectionReducer(state, { type: 'finishValidating' });
      expect(result.validatingServer).toBeNull();
    });
  });
});

describe('mcpServerFormReducer', () => {
  describe('createInitialMcpServerFormState', () => {
    it('creates empty state when no existing server', () => {
      const state = createInitialMcpServerFormState();
      expect(state).toEqual({
        name: '',
        serverType: 'stdio',
        command: '',
        args: '',
        envVars: [],
        url: '',
        headers: [],
        error: null,
        isPending: false,
      });
    });

    it('populates from existing stdio server', () => {
      const state = createInitialMcpServerFormState({
        name: 'memory',
        type: 'stdio',
        command: 'npx',
        args: ['@anthropic/mcp-server-memory'],
        env: { API_KEY: { value: 'key123', isSecret: false } },
        headers: {},
      });
      expect(state.name).toBe('memory');
      expect(state.serverType).toBe('stdio');
      expect(state.command).toBe('npx');
      expect(state.args).toBe('@anthropic/mcp-server-memory');
      expect(state.envVars).toEqual([{ key: 'API_KEY', value: 'key123', isSecret: false }]);
    });

    it('populates from existing HTTP server', () => {
      const state = createInitialMcpServerFormState({
        name: 'web-server',
        type: 'http',
        command: '',
        args: [],
        env: {},
        url: 'https://example.com/mcp',
        headers: { Authorization: { value: 'Bearer token', isSecret: true } },
      });
      expect(state.name).toBe('web-server');
      expect(state.serverType).toBe('http');
      expect(state.url).toBe('https://example.com/mcp');
      expect(state.headers).toEqual([{ key: 'Authorization', value: '', isSecret: true }]);
    });

    it('clears secret env var values', () => {
      const state = createInitialMcpServerFormState({
        name: 'test',
        type: 'stdio',
        command: 'node',
        args: [],
        env: { SECRET: { value: 'hidden', isSecret: true } },
        headers: {},
      });
      expect(state.envVars).toEqual([{ key: 'SECRET', value: '', isSecret: true }]);
    });

    it('joins args with spaces', () => {
      const state = createInitialMcpServerFormState({
        name: 'test',
        type: 'stdio',
        command: 'node',
        args: ['--flag', 'value', '--other'],
        env: {},
        headers: {},
      });
      expect(state.args).toBe('--flag value --other');
    });
  });

  describe('field updates', () => {
    it('sets name', () => {
      const state = createInitialMcpServerFormState();
      const result = mcpServerFormReducer(state, { type: 'setName', name: 'new-server' });
      expect(result.name).toBe('new-server');
    });

    it('sets server type', () => {
      const state = createInitialMcpServerFormState();
      const result = mcpServerFormReducer(state, { type: 'setServerType', serverType: 'http' });
      expect(result.serverType).toBe('http');
    });

    it('sets command', () => {
      const state = createInitialMcpServerFormState();
      const result = mcpServerFormReducer(state, { type: 'setCommand', command: 'npx' });
      expect(result.command).toBe('npx');
    });

    it('sets args', () => {
      const state = createInitialMcpServerFormState();
      const result = mcpServerFormReducer(state, {
        type: 'setArgs',
        args: '--flag value',
      });
      expect(result.args).toBe('--flag value');
    });

    it('sets envVars', () => {
      const state = createInitialMcpServerFormState();
      const envVars = [{ key: 'KEY', value: 'val', isSecret: false }];
      const result = mcpServerFormReducer(state, { type: 'setEnvVars', envVars });
      expect(result.envVars).toEqual(envVars);
    });

    it('sets url', () => {
      const state = createInitialMcpServerFormState();
      const result = mcpServerFormReducer(state, {
        type: 'setUrl',
        url: 'https://example.com',
      });
      expect(result.url).toBe('https://example.com');
    });

    it('sets headers', () => {
      const state = createInitialMcpServerFormState();
      const headers = [{ key: 'Auth', value: 'token', isSecret: true }];
      const result = mcpServerFormReducer(state, { type: 'setHeaders', headers });
      expect(result.headers).toEqual(headers);
    });

    it('sets error', () => {
      const state = createInitialMcpServerFormState();
      const result = mcpServerFormReducer(state, { type: 'setError', error: 'Name is required' });
      expect(result.error).toBe('Name is required');
    });

    it('clears error', () => {
      const state: McpServerFormState = {
        ...createInitialMcpServerFormState(),
        error: 'old error',
      };
      const result = mcpServerFormReducer(state, { type: 'setError', error: null });
      expect(result.error).toBeNull();
    });
  });

  describe('submit flow', () => {
    it('startSubmit clears error and sets isPending', () => {
      const state: McpServerFormState = {
        ...createInitialMcpServerFormState(),
        error: 'previous error',
      };
      const result = mcpServerFormReducer(state, { type: 'startSubmit' });
      expect(result.error).toBeNull();
      expect(result.isPending).toBe(true);
    });

    it('submitError sets error and clears isPending', () => {
      const state: McpServerFormState = {
        ...createInitialMcpServerFormState(),
        isPending: true,
      };
      const result = mcpServerFormReducer(state, {
        type: 'submitError',
        error: 'Failed to save',
      });
      expect(result.error).toBe('Failed to save');
      expect(result.isPending).toBe(false);
    });

    it('finishSubmit clears isPending', () => {
      const state: McpServerFormState = {
        ...createInitialMcpServerFormState(),
        isPending: true,
      };
      const result = mcpServerFormReducer(state, { type: 'finishSubmit' });
      expect(result.isPending).toBe(false);
    });
  });

  describe('state transitions', () => {
    it('handles full stdio form workflow', () => {
      let state = createInitialMcpServerFormState();

      state = mcpServerFormReducer(state, { type: 'setName', name: 'memory' });
      state = mcpServerFormReducer(state, { type: 'setCommand', command: 'npx' });
      state = mcpServerFormReducer(state, {
        type: 'setArgs',
        args: '@anthropic/mcp-server-memory',
      });
      state = mcpServerFormReducer(state, {
        type: 'setEnvVars',
        envVars: [{ key: 'TOKEN', value: 'abc', isSecret: true }],
      });

      expect(state.name).toBe('memory');
      expect(state.serverType).toBe('stdio');
      expect(state.command).toBe('npx');
      expect(state.args).toBe('@anthropic/mcp-server-memory');
      expect(state.envVars).toHaveLength(1);

      state = mcpServerFormReducer(state, { type: 'startSubmit' });
      expect(state.isPending).toBe(true);
      expect(state.error).toBeNull();
    });

    it('handles full HTTP form workflow', () => {
      let state = createInitialMcpServerFormState();

      state = mcpServerFormReducer(state, { type: 'setName', name: 'web-mcp' });
      state = mcpServerFormReducer(state, { type: 'setServerType', serverType: 'http' });
      state = mcpServerFormReducer(state, {
        type: 'setUrl',
        url: 'https://example.com/mcp',
      });
      state = mcpServerFormReducer(state, {
        type: 'setHeaders',
        headers: [{ key: 'Authorization', value: 'Bearer token', isSecret: true }],
      });

      expect(state.name).toBe('web-mcp');
      expect(state.serverType).toBe('http');
      expect(state.url).toBe('https://example.com/mcp');
      expect(state.headers).toHaveLength(1);
    });
  });
});
