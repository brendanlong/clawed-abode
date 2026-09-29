import type { KeyValueEntry, SecretValueMap } from '@/lib/key-value-entries';
import type { McpAuthType, McpServer, McpServerType } from '@/lib/settings-types';

/** The editable fields of the MCP server form, seeded from the server being edited. */
export interface McpServerFormFields {
  name: string;
  serverType: McpServerType;
  command: string;
  args: string;
  envVars: KeyValueEntry[];
  url: string;
  headers: KeyValueEntry[];
  authType: McpAuthType;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
}

/** Stored secrets arrive masked, so their rows start blank ("keep the stored value"). */
function toEntries(stored: SecretValueMap | undefined): KeyValueEntry[] {
  return Object.entries(stored ?? {}).map(([key, { value, isSecret }]) => ({
    key,
    value: isSecret ? '' : value,
    isSecret,
  }));
}

export function initialMcpServerForm(existing?: McpServer): McpServerFormFields {
  return {
    name: existing?.name ?? '',
    serverType: existing?.type ?? 'stdio',
    command: existing?.command ?? '',
    args: existing?.args.join(' ') ?? '',
    envVars: toEntries(existing?.env),
    url: existing?.url ?? '',
    headers: toEntries(existing?.headers),
    authType: existing?.authType ?? 'headers',
    // A client ID we registered dynamically isn't the user's to edit; re-submitting
    // it would pin it as manual and stop us re-registering when the issuer moves.
    oauthClientId: existing?.oauth?.clientIdIsManual ? (existing.oauth.clientId ?? '') : '',
    oauthClientSecret: '',
    oauthScope: existing?.oauth?.scope ?? '',
  };
}
