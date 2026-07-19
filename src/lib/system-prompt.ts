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
\`\`\``;

/**
 * Build the full system prompt from global settings and per-repo custom prompt.
 *
 * Order: base prompt (default or override) → global append → per-repo custom.
 */
export function buildSystemPrompt(options: {
  customSystemPrompt?: string | null;
  globalSettings?: {
    systemPromptOverride: string | null;
    systemPromptOverrideEnabled: boolean;
    systemPromptAppend: string | null;
  } | null;
}): string {
  const { customSystemPrompt, globalSettings } = options;

  let basePrompt = DEFAULT_SYSTEM_PROMPT;
  if (globalSettings?.systemPromptOverrideEnabled && globalSettings.systemPromptOverride) {
    basePrompt = globalSettings.systemPromptOverride;
  }

  let fullSystemPrompt = basePrompt;

  if (globalSettings?.systemPromptAppend) {
    fullSystemPrompt += '\n\n' + globalSettings.systemPromptAppend;
  }

  if (customSystemPrompt) {
    fullSystemPrompt += '\n\n' + customSystemPrompt;
  }

  return fullSystemPrompt;
}
