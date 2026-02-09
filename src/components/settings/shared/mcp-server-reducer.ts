import {
  SettingsListState,
  SettingsListAction,
  initialSettingsListState,
  reduceSettingsListAction,
} from './settings-list-reducer';
import type { McpServerType, ValidationResult } from '@/lib/settings-types';

// -- McpServerSection (list management) reducer --

export interface McpServerSectionState extends SettingsListState {
  validationResults: Map<string, ValidationResult>;
  validatingServer: string | null;
}

type McpServerSpecificAction =
  | { type: 'startValidating'; name: string }
  | { type: 'setValidationResult'; name: string; result: ValidationResult }
  | { type: 'finishValidating' };

export type McpServerSectionAction = SettingsListAction | McpServerSpecificAction;

export const initialMcpServerSectionState: McpServerSectionState = {
  ...initialSettingsListState,
  validationResults: new Map(),
  validatingServer: null,
};

export function mcpServerSectionReducer(
  state: McpServerSectionState,
  action: McpServerSectionAction
): McpServerSectionState {
  const baseResult = reduceSettingsListAction(state, action as SettingsListAction);
  if (baseResult) return baseResult;

  switch (action.type) {
    case 'startValidating':
      return { ...state, validatingServer: action.name };
    case 'setValidationResult': {
      const next = new Map(state.validationResults);
      next.set(action.name, action.result);
      return { ...state, validationResults: next, validatingServer: null };
    }
    case 'finishValidating':
      return { ...state, validatingServer: null };
    default:
      return state;
  }
}

// -- McpServerForm reducer --

interface KeyValueEntry {
  key: string;
  value: string;
  isSecret: boolean;
}

export interface McpServerFormState {
  name: string;
  serverType: McpServerType;
  command: string;
  args: string;
  envVars: KeyValueEntry[];
  url: string;
  headers: KeyValueEntry[];
  error: string | null;
  isPending: boolean;
}

export type McpServerFormAction =
  | { type: 'setName'; name: string }
  | { type: 'setServerType'; serverType: McpServerType }
  | { type: 'setCommand'; command: string }
  | { type: 'setArgs'; args: string }
  | { type: 'setEnvVars'; envVars: KeyValueEntry[] }
  | { type: 'setUrl'; url: string }
  | { type: 'setHeaders'; headers: KeyValueEntry[] }
  | { type: 'setError'; error: string | null }
  | { type: 'startSubmit' }
  | { type: 'submitError'; error: string }
  | { type: 'finishSubmit' };

export function createInitialMcpServerFormState(existing?: {
  name: string;
  type: McpServerType;
  command: string;
  args: string[];
  env: Record<string, { value: string; isSecret: boolean }>;
  url?: string;
  headers: Record<string, { value: string; isSecret: boolean }>;
}): McpServerFormState {
  return {
    name: existing?.name ?? '',
    serverType: existing?.type ?? 'stdio',
    command: existing?.command ?? '',
    args: existing?.args.join(' ') ?? '',
    envVars: existing?.env
      ? Object.entries(existing.env).map(([key, { value, isSecret }]) => ({
          key,
          value: isSecret ? '' : value,
          isSecret,
        }))
      : [],
    url: existing?.url ?? '',
    headers: existing?.headers
      ? Object.entries(existing.headers).map(([key, { value, isSecret }]) => ({
          key,
          value: isSecret ? '' : value,
          isSecret,
        }))
      : [],
    error: null,
    isPending: false,
  };
}

export function mcpServerFormReducer(
  state: McpServerFormState,
  action: McpServerFormAction
): McpServerFormState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.name };
    case 'setServerType':
      return { ...state, serverType: action.serverType };
    case 'setCommand':
      return { ...state, command: action.command };
    case 'setArgs':
      return { ...state, args: action.args };
    case 'setEnvVars':
      return { ...state, envVars: action.envVars };
    case 'setUrl':
      return { ...state, url: action.url };
    case 'setHeaders':
      return { ...state, headers: action.headers };
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
