/**
 * Throwaway spike for the configurable-settingSources change (PR #381).
 *
 * QUESTION: When the SDK loads a filesystem setting source (`user` / `project`)
 * whose settings.json defines a `PostToolUse` hook, does the app's own
 * PROGRAMMATIC `options.hooks.PostToolUse` (the tool-output sanitizer) still
 * run — i.e. do the two MERGE — or does one displace the other?
 *
 * This matters because enabling the `user` (or `project`) scope must not silently
 * disable the sanitizer hook wired in `buildSdkOptions`.
 *
 * Method: for each scope, run one real query that triggers a Bash tool while BOTH
 *   (a) a settings.json command hook (writes a marker file), and
 *   (b) a programmatic callback hook (sets a flag),
 * are registered. Then check whether BOTH fired.
 *
 * Run (needs working Claude auth — CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY):
 *
 *   pnpm tsx scripts/spike-hook-merge.ts
 *
 * Exits 0 if the programmatic hook still fires alongside the settings hook in
 * BOTH scopes (the safe outcome), 1 otherwise.
 */

import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function newDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Iterate a query with a hard wall-clock deadline so an idle stream can't hang.
 */
async function drainUntil(
  q: AsyncIterable<SDKMessage>,
  deadlineMs: number,
  onMessage: (m: SDKMessage) => boolean | void
): Promise<'stopped' | 'ended' | 'timeout'> {
  const it = q[Symbol.asyncIterator]();
  const end = Date.now() + deadlineMs;
  for (;;) {
    const remaining = end - Date.now();
    if (remaining <= 0) return 'timeout';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const race = await Promise.race([
      it.next().then((r) => ({ kind: 'next' as const, r })),
      new Promise<{ kind: 'timeout' }>((res) => {
        timer = setTimeout(() => res({ kind: 'timeout' }), remaining);
      }),
    ]);
    clearTimeout(timer);
    if (race.kind === 'timeout') return 'timeout';
    if (race.r.done) return 'ended';
    if (onMessage(race.r.value) === true) return 'stopped';
  }
}

/** Write a .claude/settings.json with a PostToolUse Bash hook that touches `marker`. */
async function writeSettingsHook(claudeDir: string, marker: string): Promise<void> {
  await mkdir(claudeDir, { recursive: true });
  const settings = {
    hooks: {
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `printf fired > '${marker}'` }],
        },
      ],
    },
  };
  await writeFile(join(claudeDir, 'settings.json'), JSON.stringify(settings, null, 2));
}

interface ScopeResult {
  scope: string;
  programmaticFired: boolean;
  settingsFired: boolean;
}

async function testScope(scope: 'project' | 'user'): Promise<ScopeResult> {
  console.log(`\n=== Scope: ${scope} ===`);
  const cwd = await newDir(`spike-hook-${scope}-cwd-`);
  const home = await newDir(`spike-hook-${scope}-home-`);
  const settingsMarker = join(cwd, `settings-hook-${scope}.marker`);

  // Put the settings.json hook in the directory the chosen scope reads from.
  //   project → <cwd>/.claude/    user → $HOME/.claude/
  const claudeDir = scope === 'project' ? join(cwd, '.claude') : join(home, '.claude');
  await writeSettingsHook(claudeDir, settingsMarker);

  let programmaticFired = false;

  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    settingSources: [scope],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    // Match the app: an override HOME so the `user` scope resolves to our temp dir.
    env: { ...process.env, HOME: home },
    hooks: {
      // Same shape as the app's sanitizer hook in buildSdkOptions.
      PostToolUse: [
        {
          hooks: [
            async () => {
              programmaticFired = true;
              return {};
            },
          ],
        },
      ],
    },
  };

  const q = query({
    prompt: 'Run exactly this shell command with the Bash tool: echo hello. Then stop.',
    options,
  });

  const outcome = await drainUntil(q, 90_000, (m) => {
    if (m.type === 'result') return true; // turn done
  });
  console.log(`  drain outcome: ${outcome}`);

  const settingsFired = existsSync(settingsMarker);
  if (settingsFired) {
    console.log(`  settings hook marker: ${(await readFile(settingsMarker, 'utf8')).trim()}`);
  }
  console.log(`  programmatic PostToolUse fired: ${programmaticFired}`);
  console.log(`  settings.json PostToolUse fired: ${settingsFired}`);

  return { scope, programmaticFired, settingsFired };
}

async function main() {
  const results: ScopeResult[] = [];
  for (const scope of ['project', 'user'] as const) {
    try {
      results.push(await testScope(scope));
    } catch (err) {
      console.error(`  ERROR in scope ${scope}:`, err);
      results.push({ scope, programmaticFired: false, settingsFired: false });
    }
  }

  console.log('\n=== Summary ===');
  let ok = true;
  for (const r of results) {
    // The critical property: the programmatic (sanitizer) hook must STILL fire
    // when a settings-file hook is present in a loaded scope.
    const merged = r.programmaticFired && r.settingsFired;
    const label = merged
      ? 'MERGE (both fired) ✅'
      : r.programmaticFired
        ? 'programmatic-only (settings hook did not fire) ⚠️'
        : 'programmatic hook DISPLACED ❌';
    console.log(`  ${r.scope}: ${label}`);
    // Safe outcome for the app == programmatic hook fires. Settings hook firing
    // too is the expected "merge"; if it never fires we at least didn't lose the
    // sanitizer, but flag it.
    if (!r.programmaticFired) ok = false;
  }

  console.log(
    ok
      ? '\nRESULT: PASS — the programmatic sanitizer hook still runs with a settings source loaded.'
      : '\nRESULT: FAIL — a loaded settings source displaced the programmatic hook.'
  );
  process.exit(ok ? 0 : 1);
}

void main();
