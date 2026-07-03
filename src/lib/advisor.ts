/**
 * Suggested advisor model, offered as the input placeholder — and the value an
 * empty save adopts — when enabling the advisor tool in settings. It is **not** a
 * fallback: with no advisor model set the advisor tool is disabled. Setting a
 * model is what enables the tool.
 *
 * Lives in this dependency-free module (no server-only imports) so both the
 * server (settings-merger, the globalSettings router) and the client settings
 * UI can share the single source of truth.
 */
export const SUGGESTED_ADVISOR_MODEL = 'claude-fable-5';
