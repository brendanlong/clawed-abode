/**
 * Throwaway spike for the session-cgroup change (issue #424).
 *
 * QUESTION: Can we run a whole session's Claude CLI subprocess inside a transient
 * systemd user scope by pointing the SDK's `pathToClaudeCodeExecutable` at a
 * launcher that execs the real CLI under `systemd-run --user --scope`, WITHOUT
 * breaking the SDK↔CLI stream-json protocol (which flows over stdin/stdout pipes)?
 *
 * VERIFIED (SDK 0.3.196, linux-x64): yes. The query runs normally through the
 * launcher (assistant message received → stdio forwards fine) AND the CLI runs
 * inside the named scope (`systemctl --user is-active <scope>` == active during
 * the turn). Stopping the scope then cgroup-kills the whole tree (covered by the
 * integration test). The real default CLI binary is resolved the way the SDK does
 * — from the SDK's own module context — see resolveClaudeBinary in
 * src/server/services/session-cgroup.ts.
 *
 * Run (needs working Claude auth — CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY):
 *   pnpm tsx scripts/spike-session-scope.ts
 *
 * Exits 0 if the query works through the launcher and ran inside the scope.
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_BIN_ENV,
  SESSION_SCOPE_ENV,
  SESSION_SCOPE_LAUNCHER,
} from '../src/lib/session-scope';

process.on('uncaughtException', (e: NodeJS.ErrnoException) => {
  if (e?.code !== 'EPIPE') console.log('uncaught:', String(e).slice(0, 100));
});

function resolveClaudeBinary(): string {
  const req = createRequire(import.meta.url);
  const sdkReq = createRequire(req.resolve('@anthropic-ai/claude-agent-sdk'));
  let libc = '';
  try {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } };
    if (report && !report.header?.glibcVersionRuntime) libc = '-musl';
  } catch {
    /* assume glibc */
  }
  const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}${libc}`;
  return sdkReq.resolve(`${pkg}/claude`);
}

async function main() {
  const realBin = resolveClaudeBinary();
  console.log('resolved real claude bin:', realBin);

  const dir = mkdtempSync(join(tmpdir(), 'sess-scope-'));
  const scope = 'clawed-session-spike.scope';
  const launcher = join(dir, 'launcher.sh');
  writeFileSync(launcher, SESSION_SCOPE_LAUNCHER, { mode: 0o755 });
  chmodSync(launcher, 0o755);

  let gotAssistant = false;
  let scopeSeen = 'n/a';
  const q = query({
    prompt: 'Reply with exactly: PONG',
    options: {
      cwd: dir,
      permissionMode: 'bypassPermissions',
      pathToClaudeCodeExecutable: launcher,
      env: { ...process.env, [CLAUDE_BIN_ENV]: realBin, [SESSION_SCOPE_ENV]: scope },
    },
  });

  const it = q[Symbol.asyncIterator]();
  const deadline = Date.now() + 60000;
  for (;;) {
    if (Date.now() > deadline) break;
    const race = await Promise.race([
      it.next().then((r) => ({ r })),
      new Promise<{ timeout: true }>((res) => setTimeout(() => res({ timeout: true }), 3000)),
    ]);
    if (scopeSeen === 'n/a') {
      try {
        scopeSeen = execFileSync('systemctl', ['--user', 'is-active', scope], {
          encoding: 'utf8',
        }).trim();
      } catch (e) {
        scopeSeen = String((e as { stdout?: Buffer }).stdout ?? '').trim() || 'inactive';
      }
    }
    if ('timeout' in race) continue;
    if (race.r.done) break;
    const m: SDKMessage = race.r.value;
    if (m.type === 'assistant') gotAssistant = true;
    if (m.type === 'result') break;
  }

  try {
    execFileSync('systemctl', ['--user', 'stop', scope], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }

  console.log('scope active during query:', scopeSeen);
  console.log('got assistant message:', gotAssistant);
  const ok = gotAssistant && scopeSeen === 'active';
  console.log(
    ok
      ? '\nRESULT: PASS — query works through the launcher and ran inside the session scope.'
      : '\nRESULT: FAIL — check output above.'
  );
  process.exit(ok ? 0 : 1);
}

void main();
