import { execFile } from 'child_process';

/**
 * Run git, rejecting with its stderr.
 *
 * The rejection message includes the argv, so callers must keep secrets out of
 * it — see [`github-credentials.ts`](./github-credentials.ts).
 */
export function runGit(args: string[], options: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        ...options,
        maxBuffer: 10 * 1024 * 1024,
        // Never block on a credential prompt: with no terminal to answer it, a
        // missing or rejected credential would hang instead of failing.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}
