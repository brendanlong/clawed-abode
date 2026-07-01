/**
 * Throwaway spike: capture what Claude Code actually sends to the Anthropic API
 * so we can see whether `advisorModel` in --settings causes the CLI to (a) add
 * the `advisor_20260301` tool to the request and (b) send the
 * `anthropic-beta: advisor-tool-2026-03-01` header.
 *
 * Runs a logging reverse-proxy in front of api.anthropic.com, points the CLI at
 * it with ANTHROPIC_BASE_URL, runs one query per config, and prints for the
 * first /v1/messages call: the anthropic-beta header + any advisor-ish tool.
 *
 *   pnpm tsx scripts/spike-advisor-proxy.ts
 */

import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';

const UPSTREAM = 'api.anthropic.com';

type Capture = { beta: string | undefined; toolTypes: string[]; advisor: boolean };
const captures: Capture[] = [];

function startProxy(): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url?.includes('/v1/messages')) {
        try {
          const parsed = JSON.parse(body.toString('utf8')) as {
            tools?: Array<{ type?: string; name?: string }>;
          };
          const toolTypes = (parsed.tools ?? []).map((t) => t.type ?? t.name ?? '?');
          captures.push({
            beta: req.headers['anthropic-beta'] as string | undefined,
            toolTypes,
            advisor: toolTypes.some((t) => /advisor/i.test(t)),
          });
        } catch {
          /* non-JSON body (e.g. count_tokens) — ignore */
        }
      }
      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];
      const upstreamReq = https.request(
        {
          hostname: UPSTREAM,
          path: req.url,
          method: req.method,
          headers: { ...headers, host: UPSTREAM },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      );
      upstreamReq.on('error', (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      upstreamReq.end(body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

async function runConfig(
  label: string,
  settings: Record<string, unknown>,
  baseUrl: string,
  extraEnv: Record<string, string>
) {
  const cwd = await mkdtemp(join(tmpdir(), 'advisor-proxy-'));
  const before = captures.length;
  const options: Options = {
    cwd,
    permissionMode: 'bypassPermissions',
    tools: { type: 'preset', preset: 'claude_code' },
    extraArgs: { settings: JSON.stringify(settings) },
    env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl, ...extraEnv } as Record<string, string>,
  };
  try {
    for await (const message of query({ prompt: 'Say hi.', options })) {
      if (message.type === 'result') break;
    }
  } catch (err) {
    console.log(`[${label}] query error:`, err instanceof Error ? err.message : err);
  }
  const cap = captures.slice(before).find((c) => c.toolTypes.length > 0) ?? captures[before];
  console.log(`\n=== ${label} ===`);
  if (!cap) {
    console.log('  no /v1/messages capture');
    return;
  }
  console.log(`  anthropic-beta: ${cap.beta ?? '(none)'}`);
  console.log(`  advisor tool in request: ${cap.advisor ? 'YES' : 'no'}`);
  console.log(`  tool types: ${cap.toolTypes.join(', ') || '(none)'}`);
}

async function main() {
  const { port, close } = await startProxy();
  const baseUrl = `http://127.0.0.1:${port}`;
  const advisorModel = 'claude-fable-5';
  try {
    await runConfig('A: advisorModel only', { advisorModel }, baseUrl, {});
    await runConfig('B: advisorModel + ENABLE_EXPERIMENTAL flag', { advisorModel }, baseUrl, {
      CLAUDE_CODE_ENABLE_EXPERIMENTAL_ADVISOR_TOOL: '1',
    });
  } finally {
    close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
