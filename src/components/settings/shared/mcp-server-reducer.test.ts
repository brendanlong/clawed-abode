import { describe, it, expect } from 'vitest';
import {
  mcpServerSectionReducer,
  initialMcpServerSectionState,
  mcpServerFormReducer,
  createInitialMcpServerFormState,
} from './mcp-server-reducer';
import type { McpServerSectionState, McpServerFormState } from './mcp-server-reducer';

describe('mcpServerSectionReducer', () => {
  it('delegates shared list actions and preserves its own fields', () => {
    const state: McpServerSectionState = {
      ...initialMcpServerSectionState,
      validatingServer: 'memory',
    };
    const result = mcpServerSectionReducer(state, { type: 'openForm' });
    expect(result).toEqual({ ...state, showForm: true });
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
        authType: 'headers',
        oauthClientId: '',
        oauthClientSecret: '',
        oauthScope: '',
        error: null,
        isPending: false,
      });
    });

    it('populates from existing stdio server', () => {
      const state = createInitialMcpServerFormState({
        id: '1',
        authType: 'headers',
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
        id: '2',
        authType: 'headers',
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
        id: '3',
        authType: 'headers',
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
        id: '3',
        authType: 'headers',
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

  describe('OAuth connect actions', () => {
    it('clears a previous error when a new attempt starts', () => {
      const failed = mcpServerSectionReducer(initialMcpServerSectionState, {
        type: 'connectFailed',
        name: 'remote',
        error: 'discovery failed',
      });
      expect(failed.connectErrors.get('remote')).toBe('discovery failed');
      expect(failed.connectingServer).toBeNull();

      const retried = mcpServerSectionReducer(failed, { type: 'startConnecting', name: 'remote' });
      expect(retried.connectingServer).toBe('remote');
      expect(retried.connectErrors.has('remote')).toBe(false);
    });

    it('leaves other servers\u2019 errors alone', () => {
      const withError = mcpServerSectionReducer(initialMcpServerSectionState, {
        type: 'connectFailed',
        name: 'other',
        error: 'boom',
      });
      const started = mcpServerSectionReducer(withError, {
        type: 'startConnecting',
        name: 'remote',
      });
      expect(started.connectErrors.get('other')).toBe('boom');
    });

    it('stops the spinner on success without recording an error', () => {
      const started = mcpServerSectionReducer(initialMcpServerSectionState, {
        type: 'startConnecting',
        name: 'remote',
      });
      const done = mcpServerSectionReducer(started, { type: 'connectFinished', name: 'remote' });
      expect(done.connectingServer).toBeNull();
      expect(done.connectErrors.size).toBe(0);
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
  });
});
