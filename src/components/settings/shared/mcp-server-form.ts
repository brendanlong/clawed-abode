import {
  buildKeyValueRecord,
  type KeyValueEntry,
  type SecretValueMap,
} from '@/lib/key-value-entries';
import type { McpAuthType, McpServer, McpServerType } from '@/lib/settings-types';
import type { McpServerInput } from '@/server/services/settings-helpers';

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

export type McpServerInputResult =
  { ok: true; input: McpServerInput } | { ok: false; error: string };

/** Validate the form and build what `setMcpServer` takes, keeping only the fields its type uses. */
export function buildMcpServerInput(
  form: McpServerFormFields,
  existing: McpServer | undefined
): McpServerInputResult {
  if (!form.name) return { ok: false, error: 'Name is required' };

  if (form.serverType === 'stdio') {
    if (!form.command) return { ok: false, error: 'Command is required' };

    const env = buildKeyValueRecord(form.envVars, existing?.env, 'environment variable');
    if (!env.ok) return env;

    return {
      ok: true,
      input: {
        name: form.name,
        type: 'stdio',
        command: form.command,
        args: form.args.split(/\s+/).filter(Boolean),
        env: Object.keys(env.record).length > 0 ? env.record : undefined,
      },
    };
  }

  if (!form.url) return { ok: false, error: 'URL is required' };

  const headers = buildKeyValueRecord(form.headers, existing?.headers, 'header');
  if (!headers.ok) return headers;

  return {
    ok: true,
    input: {
      name: form.name,
      type: form.serverType,
      url: form.url,
      headers: Object.keys(headers.record).length > 0 ? headers.record : undefined,
      authType: form.authType,
      oauth:
        form.authType === 'oauth'
          ? {
              clientId: form.oauthClientId.trim(),
              clientSecret: form.oauthClientSecret,
              scope: form.oauthScope.trim(),
            }
          : undefined,
    },
  };
}
