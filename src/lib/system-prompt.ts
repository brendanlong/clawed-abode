/**
 * Pure system-prompt construction. Lives in lib (not the runner) so settings
 * code can build prompts without importing the runner — which would create an
 * import cycle once the runner imports the settings merger.
 */

// Default system prompt appended to all Claude sessions.
export const DEFAULT_SYSTEM_PROMPT = `IMPORTANT: The user is accessing this session remotely through a web interface and has no local access to the files. They can only see your changes through GitHub. Therefore, you MUST follow this workflow for ANY code changes:

1. Always commit your changes with clear, descriptive commit messages
2. Always push your commits to the remote repository
3. If you're working on a new branch or the changes would benefit from review, open a Pull Request using the GitHub CLI (gh pr create)
4. If a PR already exists for the current branch, just push to update it

Never leave uncommitted or unpushed changes - the user cannot see them otherwise.

This host is shared: other sessions and the app server run as the same user, so a bare \`pkill\`/\`killall\` by name can kill their processes. Kill by explicit PID. Only pattern-kill if you scope it to your own session's cgroup, and only when \`cat /proc/self/cgroup\` ends in \`clawed-session-<id>.scope\` (otherwise you share a cgroup with the server, so kill by PID):

\`\`\`
pkill --cgroup "$(sed 's#^0::##' /proc/self/cgroup)" -f <pattern>
\`\`\`

For the same reason, don't touch global or user-level configuration unless the user explicitly asks: no \`git config --global\`, \`~/.bashrc\`, or other \`$HOME\` dotfiles. Those changes permanently affect every other session on this host. Scope tests to your repo or environment if necessary.`;

export interface PublicDirInfo {
  path: string;
  /** Absolute URL when the app's origin is known, else a path on it. */
  url: string;
}

export function buildPublicDirNote({ path, url }: PublicDirInfo): string {
  const where = url.startsWith('/')
    ? `at the path \`${url}\` on the same host the user reaches this web UI on`
    : `at ${url}`;
  return `To show the user something in their browser (HTML reports, plots, small demos), write it to \`${path}\` (create the directory if needed) instead of starting your own HTTP server. This app serves that directory ${where}; directories serve \`index.html\` or a file listing, and relative links between files work. Pages run sandboxed with an opaque origin: no cookies or localStorage, and \`fetch()\`/XHR and \`<script type="module">\` can't load other files from the directory, so inline data and use classic \`<script src>\` tags (images, stylesheets, and classic scripts load fine).`;
}

/**
 * Build the full system prompt from global settings and per-repo custom prompt.
 *
 * Order: base prompt (default or override) → public-dir note → global append → per-repo custom.
 * The public-dir note describes the session rather than policy, so an override keeps it.
 */
export function buildSystemPrompt(options: {
  publicDir?: PublicDirInfo;
  customSystemPrompt?: string | null;
  globalSettings?: {
    systemPromptOverride: string | null;
    systemPromptOverrideEnabled: boolean;
    systemPromptAppend: string | null;
  } | null;
}): string {
  const { publicDir, customSystemPrompt, globalSettings } = options;

  let basePrompt = DEFAULT_SYSTEM_PROMPT;
  if (globalSettings?.systemPromptOverrideEnabled && globalSettings.systemPromptOverride) {
    basePrompt = globalSettings.systemPromptOverride;
  }

  let fullSystemPrompt = basePrompt;

  if (publicDir) {
    fullSystemPrompt += '\n\n' + buildPublicDirNote(publicDir);
  }

  if (globalSettings?.systemPromptAppend) {
    fullSystemPrompt += '\n\n' + globalSettings.systemPromptAppend;
  }

  if (customSystemPrompt) {
    fullSystemPrompt += '\n\n' + customSystemPrompt;
  }

  return fullSystemPrompt;
}
