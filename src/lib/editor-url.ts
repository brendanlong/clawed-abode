/**
 * Builds deep links into a self-hosted code-server (browser VS Code) instance
 * so the operator can view/edit a session's worktree files remotely.
 *
 * code-server opens a folder via the `?folder=<absolute-path>` query param, so
 * the link is just the configured base URL plus the session's absolute working
 * directory. Kept pure and dependency-free so it is trivially unit-testable and
 * shared by the router.
 */

/**
 * Build a code-server deep link that opens `folderPath` in the editor.
 *
 * @param baseUrl  Base URL where code-server is reachable (e.g.
 *   `https://host.tailnet.ts.net:8443`). When empty/undefined the feature is
 *   considered disabled and `null` is returned.
 * @param folderPath  Absolute path to the folder to open.
 * @returns The deep link, or `null` when the editor is not configured.
 */
export function buildEditorUrl(
  baseUrl: string | undefined | null,
  folderPath: string
): string | null {
  if (!baseUrl) {
    return null;
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return null;
  }
  return `${trimmed}/?folder=${encodeURIComponent(folderPath)}`;
}
