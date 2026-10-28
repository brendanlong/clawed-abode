#!/usr/bin/env tsx
/**
 * Regenerate the README screenshots (doc/screenshots/*.png) from a throwaway
 * instance: a fresh database seeded by readme-screenshots-seed.ts, served by
 * `next dev` with HOME pointed at a temp dir so its workspaces never touch the
 * real ~/worktrees.
 *
 * Usage: pnpm readme-screenshots
 * Needs Playwright's Chromium (`pnpm exec playwright install chromium`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { hashPassword } from '@/lib/auth';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'doc', 'screenshots');
const PASSWORD = 'demo-password';

const DESKTOP = { width: 1280, height: 800 };
const SESSION = { width: 1280, height: 1100 };
const PHONE = { width: 390, height: 844 };
const PHONE_GAP = 40;

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port'))
      );
    });
  });
}

async function waitForServer(url: string, server: ChildProcess): Promise<void> {
  for (;;) {
    if (server.exitCode !== null) throw new Error(`next dev exited ${server.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    server.on('exit', () => resolve());
    // The whole group, so the signal reaches next's own child processes; their
    // shutdown handler stops the demo sessions' CLIs.
    process.kill(-server.pid!, 'SIGTERM');
  });
}

async function openPage(
  browser: Browser,
  baseUrl: string,
  route: string,
  ready: string,
  options: BrowserContextOptions
): Promise<Page> {
  const context = await browser.newContext({ deviceScaleFactor: 2, ...options });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/login`);
  await page.getByPlaceholder('Enter your password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  await page.goto(`${baseUrl}${route}`);
  // Not networkidle: the SSE stream never goes idle.
  await page.getByText(ready).first().waitFor();
  // Hide the dev overlay's issue badge (React dev mode's eval, which our CSP blocks).
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  return page;
}

async function sessionRoute(page: Page, name: string): Promise<string> {
  const href = await page.getByRole('link', { name }).first().getAttribute('href');
  if (!href) throw new Error(`No session named ${name}`);
  return href;
}

async function scrollToTop(page: Page, text: string): Promise<void> {
  await page
    .getByText(text)
    .first()
    .evaluate((element) => element.scrollIntoView({ block: 'start' }));
}

async function save(page: Page, file: string): Promise<void> {
  const outputPath = path.join(outDir, file);
  await page.screenshot({ path: outputPath, animations: 'disabled' });
  console.log(`Wrote ${outputPath}`);
}

async function capture(baseUrl: string) {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const desktop = { viewport: DESKTOP };
    const phone = { viewport: PHONE, isMobile: true, hasTouch: true };

    const dark = { ...phone, colorScheme: 'dark' } as const;

    // Both lists before any session is opened, since opening one clears its notification.
    const list = await openPage(browser, baseUrl, '/', 'Upgrade to Next.js 16', desktop);
    await save(list, 'sessions.png');
    const phoneList = await openPage(browser, baseUrl, '/', 'Upgrade to Next.js 16', dark);
    const phoneListShot = await phoneList.screenshot({ animations: 'disabled' });

    const tabTitle = await sessionRoute(list, 'Unread count in tab title');
    const sweep = await sessionRoute(list, 'Learning-rate sweep');

    const session = await openPage(browser, baseUrl, tabTitle, 'Four unit tests', {
      viewport: SESSION,
    });
    await session.getByRole('button', { name: /Edit\s*AppShell\.tsx/ }).click();
    await session.getByRole('button', { name: /Run the new title tests/ }).click();
    await scrollToTop(session, 'The counts are already cached');
    await save(session, 'session.png');

    const phoneSession = await openPage(browser, baseUrl, sweep, '3e-4 wins', dark);
    await scrollToTop(phoneSession, 'The sweep finished');
    const shots = [phoneListShot, await phoneSession.screenshot({ animations: 'disabled' })];

    // Lay the two phone shots side by side on a transparent background.
    const composite = await browser.newPage({
      viewport: { width: PHONE.width * 2 + PHONE_GAP, height: PHONE.height },
      deviceScaleFactor: 2,
    });
    const images = shots
      .map((shot) => `<img src="data:image/png;base64,${shot.toString('base64')}">`)
      .join('');
    await composite.setContent(
      `<style>html,body{margin:0;background:transparent}body{display:flex;gap:${PHONE_GAP}px}` +
        `img{width:${PHONE.width}px;height:${PHONE.height}px;border-radius:24px}</style>${images}`
    );
    await composite.screenshot({ path: path.join(outDir, 'mobile.png'), omitBackground: true });
    console.log(`Wrote ${path.join(outDir, 'mobile.png')}`);
  } finally {
    await browser.close();
  }
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), 'clawed-abode-screenshots-'));
  const home = path.join(tmp, 'home');
  await mkdir(home);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    DATABASE_URL: `file:${path.join(tmp, 'demo.db')}`,
    PASSWORD_HASH: Buffer.from(await hashPassword(PASSWORD)).toString('base64'),
    NEXT_TELEMETRY_DISABLED: '1',
  };
  let server: ChildProcess | undefined;
  try {
    await run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], env);
    await run('pnpm', ['exec', 'tsx', 'scripts/readme-screenshots-seed.ts'], env);
    server = spawn('pnpm', ['exec', 'next', 'dev', '-p', String(port), '-H', '127.0.0.1'], {
      cwd: root,
      env,
      stdio: 'inherit',
      detached: true,
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(`${baseUrl}/login`, server);
    await capture(baseUrl);
  } finally {
    if (server) await stopServer(server);
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
