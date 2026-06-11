/**
 * Clawed Abode terminal hub.
 *
 * A single entry point for managing Claude Code sessions over SSH/Termux:
 * list sessions, attach (full-screen handover to the Claude TUI in tmux),
 * detach back here with F12 (or Ctrl-b d), create sessions with per-repo
 * settings from the database, edit settings, and stop/archive sessions.
 *
 * Claude runs as the interactive TUI, so usage stays in the
 * subscription-billed interactive pool (not the Agent SDK credit pool).
 */

import './load-env';
import { select, input, confirm, editor, Separator } from '@inquirer/prompts';
import type { Session } from '@prisma/client';
import { extractRepoFullName } from '@/lib/utils';
import { SESSION_NAME_MAX_LENGTH, NO_REPO_SENTINEL } from '@/lib/types';
import { generateIssuePrompt } from '@/lib/issue-prompt';
import {
  listCliSessions,
  createCliSession,
  attachCliSession,
  stopCliSession,
  archiveCliSession,
  type CliSession,
} from './sessions';
import { pickRepo, pickBranch, pickIssue, pickSettingsRepo } from './pickers';
import {
  loadGlobalSettingsDoc,
  saveGlobalSettingsDoc,
  loadRepoSettingsDoc,
  saveRepoSettingsDoc,
  globalSettingsDocSchema,
  repoSettingsDocSchema,
} from './settings';
import { editDocument } from './editor';

function sessionLabel(session: CliSession): string {
  const liveness = session.tmuxAlive ? '●' : '○';
  const repo = session.repoUrl
    ? `${extractRepoFullName(session.repoUrl)}@${session.currentBranch ?? session.branch}`
    : 'workspace';
  return `${liveness} ${session.name}  (${repo})`;
}

/**
 * Attach to a session and, when the user comes back, ask what to do with it.
 */
async function attachAndSettle(session: Session): Promise<void> {
  console.log('Attaching — press F12 (or Ctrl-b d) to come back here.');
  const { stillRunning } = await attachCliSession(session);

  if (stillRunning) {
    const action = await select({
      message: `"${session.name}" is still running in the background.`,
      choices: [
        { name: 'Keep it running', value: 'keep' },
        { name: 'Reattach', value: 'reattach' },
        { name: 'Stop & archive', value: 'archive' },
        { name: 'Stop (keep workspace)', value: 'stop' },
      ],
    });

    if (action === 'reattach') return attachAndSettle(session);
    if (action === 'archive') await archiveAfterConfirm(session);
    if (action === 'stop') {
      await stopCliSession(session);
      console.log('Stopped. Attach later to resume the conversation.');
    }
    return;
  }

  // Claude exited (or crashed) — the tmux session is gone
  const action = await select({
    message: `Claude exited in "${session.name}".`,
    choices: [
      { name: 'Keep session (resume later)', value: 'keep' },
      { name: 'Archive it', value: 'archive' },
    ],
  });

  if (action === 'archive') {
    await archiveAfterConfirm(session);
  } else {
    await stopCliSession(session);
  }
}

async function archiveAfterConfirm(session: Session): Promise<boolean> {
  const sure = await confirm({
    message: `Archive "${session.name}"? This stops Claude and deletes the workspace (any unpushed changes are lost).`,
    default: false,
  });
  if (!sure) return false;
  await archiveCliSession(session);
  console.log('Archived.');
  return true;
}

async function newSessionFlow(): Promise<void> {
  const repoFullName = await pickRepo();

  let branch: string | undefined;
  let issuePrompt: string | undefined;
  let defaultName = 'Workspace';

  if (repoFullName) {
    branch = await pickBranch(repoFullName);
    defaultName = repoFullName.split('/')[1];

    const issue = await pickIssue(repoFullName);
    if (issue) {
      defaultName = issue.title.slice(0, SESSION_NAME_MAX_LENGTH);
      issuePrompt = generateIssuePrompt(issue, repoFullName);
    }
  }

  const name = await input({
    message: 'Session name:',
    default: defaultName,
    validate: (value) =>
      value.trim().length > 0 && value.length <= SESSION_NAME_MAX_LENGTH
        ? true
        : `1-${SESSION_NAME_MAX_LENGTH} characters`,
  });

  let initialPrompt: string | undefined;
  if (issuePrompt) {
    const editPrompt = await select({
      message: 'Initial prompt (from issue):',
      choices: [
        { name: 'Use as-is', value: 'use' },
        { name: 'Edit in $EDITOR', value: 'edit' },
        { name: 'No initial prompt', value: 'none' },
      ],
    });
    if (editPrompt === 'use') initialPrompt = issuePrompt;
    if (editPrompt === 'edit') {
      initialPrompt = await editor({ message: 'Edit the initial prompt', default: issuePrompt });
    }
  } else {
    const prompt = await editor({
      message: 'Initial prompt (optional, opens $EDITOR — leave empty to skip)',
      default: '',
    });
    initialPrompt = prompt.trim() ? prompt : undefined;
  }

  const session = await createCliSession({
    name: name.trim(),
    repoFullName: repoFullName ?? undefined,
    branch,
    initialPrompt,
    onProgress: (message) => console.log(message),
  });

  await attachAndSettle(session);
}

async function settingsMenu(): Promise<void> {
  while (true) {
    const target = await select({
      message: 'Settings',
      choices: [
        { name: 'Global settings', value: 'global' },
        { name: 'Repository settings', value: 'repo' },
        { name: '(back)', value: 'back' },
      ],
    });
    if (target === 'back') return;

    if (target === 'global') {
      const doc = await loadGlobalSettingsDoc();
      const edited = await editDocument({
        schema: globalSettingsDocSchema,
        initial: doc,
        helpLines: [
          'Global settings (applies to all sessions). Secrets are shown decrypted',
          'and re-encrypted on save. claudeApiKey: Claude Code OAuth token or null.',
          'envVars: [{ name, value, isSecret }]. mcpServers: stdio { name, command,',
          'args?, env? } or http/sse { name, type, url, headers? } where env/headers',
          'values are { value, isSecret }. Lines starting with // are ignored.',
        ],
      });
      if (edited) {
        await saveGlobalSettingsDoc(edited);
        console.log('Global settings saved.');
      }
    } else {
      const repoFullName = await pickSettingsRepo();
      if (!repoFullName) continue;
      const doc = await loadRepoSettingsDoc(repoFullName);
      const edited = await editDocument({
        schema: repoSettingsDocSchema,
        initial: doc,
        helpLines: [
          `Settings for ${repoFullName === NO_REPO_SENTINEL ? 'workspace-only sessions' : repoFullName}.`,
          'These are merged over the global settings (same names win).',
          'envVars: [{ name, value, isSecret }]. mcpServers: stdio { name, command,',
          'args?, env? } or http/sse { name, type, url, headers? } where env/headers',
          'values are { value, isSecret }. Lines starting with // are ignored.',
        ],
      });
      if (edited) {
        await saveRepoSettingsDoc(repoFullName, edited);
        console.log(`Settings for ${repoFullName} saved.`);
      }
    }
  }
}

async function archivedMenu(): Promise<void> {
  const archived = await listCliSessions({ archived: true });
  if (archived.length === 0) {
    console.log('No archived sessions.');
    return;
  }
  console.log('\nArchived sessions (read-only):');
  for (const session of archived) {
    const repo = session.repoUrl ? extractRepoFullName(session.repoUrl) : 'workspace';
    console.log(
      `  ${session.name}  (${repo}, archived ${session.archivedAt?.toLocaleDateString()})`
    );
  }
  console.log('');
}

async function sessionMenu(session: CliSession): Promise<void> {
  const action = await select({
    message: sessionLabel(session),
    choices: [
      { name: session.tmuxAlive ? 'Attach' : 'Resume & attach', value: 'attach' },
      { name: 'Stop & archive', value: 'archive' },
      ...(session.tmuxAlive ? [{ name: 'Stop (keep workspace)', value: 'stop' }] : []),
      { name: '(back)', value: 'back' },
    ],
  });

  if (action === 'attach') await attachAndSettle(session);
  if (action === 'archive') await archiveAfterConfirm(session);
  if (action === 'stop') {
    await stopCliSession(session);
    console.log('Stopped.');
  }
}

async function mainLoop(): Promise<void> {
  while (true) {
    const sessions = await listCliSessions();

    const choice = await select<CliSession | 'new' | 'settings' | 'archived' | 'quit'>({
      message: 'Clawed Abode — sessions (● running, ○ stopped)',
      choices: [
        ...sessions.map((session) => ({ name: sessionLabel(session), value: session })),
        ...(sessions.length > 0 ? [new Separator()] : []),
        { name: '+ New session', value: 'new' as const },
        { name: 'Settings', value: 'settings' as const },
        { name: 'Archived sessions', value: 'archived' as const },
        { name: 'Quit', value: 'quit' as const },
      ],
      pageSize: 15,
    });

    try {
      if (choice === 'quit') return;
      else if (choice === 'new') await newSessionFlow();
      else if (choice === 'settings') await settingsMenu();
      else if (choice === 'archived') await archivedMenu();
      else await sessionMenu(choice);
    } catch (error) {
      // Surface action errors but keep the hub alive
      console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

mainLoop()
  .catch((error: unknown) => {
    if (error instanceof Error && error.name === 'ExitPromptError') {
      return; // Ctrl-C at a prompt — clean exit
    }
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    // Prisma keeps the event loop alive otherwise
    process.exit(process.exitCode ?? 0);
  });
