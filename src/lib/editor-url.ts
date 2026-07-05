/**
 * Builds deep links into a self-hosted code-server (browser VS Code) instance
 * so the operator can view/edit a session's worktree files remotely.
 *
 * Two link shapes are supported, both keyed off the same configured base URL:
 *
 * - A **folder** link (`?folder=<abs-path>`) that opens the session's worktree,
 *   used by the header "Open in VS Code" button.
 * - A **file** link that opens one specific file, used by the Read/Edit/Write
 *   tool displays so each has an "open this file" affordance.
 *
 * code-server has no documented query param for opening a single file, but its
 * web workbench honors VS Code's `payload=[["openFile", <uri>]]` mechanism. The
 * file must be addressed with the workbench's remote authority — for code-server
 * that authority is the constant `remote` — as `vscode-remote://remote<abs-path>`.
 * This was verified empirically against a live code-server: the folder link plus
 * that payload opens the exact file (a `:line:col` suffix does NOT work — it is
 * treated as a literal filename — so file links intentionally carry no position).
 *
 * Kept pure and dependency-free so it is trivially unit-testable and shared by
 * the server router and the client components.
 */

/**
 * The remote authority code-server's web workbench uses for on-disk files.
 * Constant for code-server (unlike a true VS Code Remote setup). See module doc.
 */
const REMOTE_AUTHORITY = 'remote';

/** The pieces the client needs to build editor deep links, or `null` fields when disabled. */
export interface EditorInfo {
  /** Base URL where code-server is reachable (e.g. `https://code.tailnet.ts.net`). */
  baseUrl: string;
  /** Absolute path to the session's worktree folder. */
  workspaceDir: string;
}

/** Normalize a configured base URL, returning `null` when unset/blank. */
function normalizeBaseUrl(baseUrl: string | undefined | null): string | null {
  if (!baseUrl) {
    return null;
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed || null;
}

/**
 * Build a code-server deep link that opens `folderPath` in the editor.
 *
 * @param baseUrl  Base URL where code-server is reachable. When empty/undefined
 *   the feature is considered disabled and `null` is returned.
 * @param folderPath  Absolute path to the folder to open.
 * @returns The deep link, or `null` when the editor is not configured.
 */
export function buildEditorFolderUrl(
  baseUrl: string | undefined | null,
  folderPath: string
): string | null {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) {
    return null;
  }
  return `${base}/?folder=${encodeURIComponent(folderPath)}`;
}

/**
 * Build a code-server deep link that opens one specific file, within the given
 * workspace folder for context.
 *
 * @param baseUrl  Base URL where code-server is reachable. When empty/undefined
 *   the feature is considered disabled and `null` is returned.
 * @param workspaceDir  Absolute path to the worktree folder to open alongside.
 * @param filePath  Absolute path to the file to open.
 * @returns The deep link, or `null` when the editor is not configured or the
 *   file path is not absolute.
 */
export function buildEditorFileUrl(
  baseUrl: string | undefined | null,
  workspaceDir: string,
  filePath: string
): string | null {
  const base = normalizeBaseUrl(baseUrl);
  if (!base || !filePath.startsWith('/')) {
    return null;
  }
  // Percent-encode each path segment (preserving separators) so a path with
  // spaces or special characters still forms a valid URI for VS Code's URI.parse.
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const fileUri = `vscode-remote://${REMOTE_AUTHORITY}${encodedPath}`;
  const payload = JSON.stringify([['openFile', fileUri]]);
  return `${base}/?folder=${encodeURIComponent(workspaceDir)}&payload=${encodeURIComponent(payload)}`;
}
