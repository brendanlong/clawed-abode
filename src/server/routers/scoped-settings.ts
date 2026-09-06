import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { protectedProcedure } from '../trpc';
import { envVarNameSchema, envVarSchema, mcpServerSchema } from '../services/settings-helpers';
import {
  deleteEnvVar,
  deleteMcpServer,
  getEnvVarValue,
  upsertEnvVar,
  upsertMcpServer,
  validateScopeMcpServer,
  type SettingsScope,
} from '../services/settings-scope';

/**
 * How a router turns its own input (e.g. `repoFullName`) into a settings scope.
 * `write` may create the owning row; `read` returns null when it doesn't exist,
 * which deletes treat as a no-op and lookups as NOT_FOUND.
 */
export type ResolveScope<ScopeInput> = (
  input: ScopeInput,
  mode: 'read' | 'write'
) => Promise<SettingsScope | null>;

const mcpServerNameSchema = z.string().min(1);

/**
 * The env-var and MCP-server procedures shared by the global and per-repo
 * settings routers. `scopeInput` is the router's scope-identifying input (an
 * empty object for global); each procedure's input is that plus its own fields.
 */
export function scopedSettingsProcedures<ScopeInput extends object>(
  // Both type params: tRPC derives the client input type from the schema's *input* side.
  scopeInput: z.ZodType<ScopeInput, ScopeInput>,
  resolveScope: ResolveScope<ScopeInput>
) {
  // Intersections (not .extend) so the inferred input is `ScopeInput & {...}`
  // regardless of how ScopeInput was declared.
  const withScope = <T extends z.ZodRawShape>(shape: T) =>
    protectedProcedure.input(z.intersection(scopeInput, z.object(shape)));

  // Inside a generic, tRPC types each handler's input as an unresolved
  // conditional over ScopeInput; the runtime value is ScopeInput plus the
  // procedure's own fields, which is what resolveScope needs.
  const scopeOf = (input: object) => input as ScopeInput;

  const writeScope = async (input: object): Promise<SettingsScope> => {
    const scope = await resolveScope(scopeOf(input), 'write');
    if (!scope) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
    return scope;
  };
  const readScope = async (input: object): Promise<SettingsScope> => {
    const scope = await resolveScope(scopeOf(input), 'read');
    if (!scope) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Repository settings not found' });
    }
    return scope;
  };

  return {
    setEnvVar: withScope({ envVar: envVarSchema }).mutation(async ({ input }) => {
      await upsertEnvVar(await writeScope(input), input.envVar);
      return { success: true };
    }),

    deleteEnvVar: withScope({ name: envVarNameSchema }).mutation(async ({ input }) => {
      const scope = await resolveScope(scopeOf(input), 'read');
      if (scope) await deleteEnvVar(scope, input.name);
      return { success: true };
    }),

    getEnvVarValue: withScope({ name: envVarNameSchema }).query(async ({ input }) => ({
      value: await getEnvVarValue(await readScope(input), input.name),
    })),

    setMcpServer: withScope({ mcpServer: mcpServerSchema }).mutation(async ({ input }) => {
      await upsertMcpServer(await writeScope(input), input.mcpServer);
      return { success: true };
    }),

    deleteMcpServer: withScope({ name: mcpServerNameSchema }).mutation(async ({ input }) => {
      const scope = await resolveScope(scopeOf(input), 'read');
      if (scope) await deleteMcpServer(scope, input.name);
      return { success: true };
    }),

    validateMcpServer: withScope({ name: mcpServerNameSchema }).mutation(async ({ input }) =>
      validateScopeMcpServer(await readScope(input), input.name)
    ),
  };
}
