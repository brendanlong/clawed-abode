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

This is a shared host: other sessions run as the same user, alongside the server that hosts this app. Never run a bare \`pkill\`/\`killall\` by name - it matches processes across the whole host and can kill other sessions' work or the server itself. Prefer to kill by explicit PID.

If you must pattern-kill, you can scope it to your own session's cgroup - but only when you're in a dedicated session scope. Check first: \`cat /proc/self/cgroup\` should end in \`clawed-session-<id>.scope\`. If it does, this only touches processes you started:

\`\`\`
pkill --cgroup "$(sed 's#^0::##' /proc/self/cgroup)" -f <pattern>
\`\`\`

If it does NOT end in a session scope, you're in a cgroup shared with the server and other sessions - do not use \`--cgroup\`; kill by explicit PID instead.`;

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
