import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { generateImage, type GenerateImageInput } from './image-generation';

const workspace = vi.hoisted(() => ({ dir: '' }));
vi.mock('./worktree-manager', () => ({ getSessionWorkspacePath: () => workspace.dir }));

const mockEnv = vi.hoisted(() => ({
  LLM_PROXY_URL: '' as string | undefined,
  LLM_PROXY_KEY: 'sk-proxy' as string | undefined,
  PUBLIC_FILES_URL: 'https://files.example/' as string | undefined,
}));
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  env: mockEnv,
}));

const PNG_BYTES = Buffer.from('fake png bytes');

/** What the fake proxy answers next, and every request it got. */
const proxy = {
  status: 200,
  body: '',
  /** Never answer, so a test can abort mid-request. */
  hang: false,
  requests: [] as { headers: IncomingMessage['headers']; url?: string; json: unknown }[],
};

function imageStream(): string {
  const item = {
    type: 'image_generation_call',
    result: PNG_BYTES.toString('base64'),
    revised_prompt: 'A red circle',
    size: '1024x1024',
    output_format: 'png',
  };
  return `data: ${JSON.stringify({ type: 'response.output_item.done', item })}\n\ndata: [DONE]\n\n`;
}

let server: Server;
let workingDir: string;

const baseInput: GenerateImageInput = {
  model: 'gpt-image',
  prompt: 'A red circle',
  inputImages: [],
  size: 'auto',
  background: 'auto',
};

describe('generateImage', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        proxy.requests.push({ headers: req.headers, url: req.url, json: JSON.parse(body) });
        if (proxy.hang) return;
        res.writeHead(proxy.status, { 'Content-Type': 'text/event-stream' });
        res.end(proxy.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mockEnv.LLM_PROXY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    workspace.dir = await mkdtemp(path.join(tmpdir(), 'image-gen-'));
    workingDir = path.join(workspace.dir, 'repo');
    await mkdir(workingDir);
    proxy.status = 200;
    proxy.body = imageStream();
    proxy.requests = [];
    proxy.hang = false;
    return () => rm(workspace.dir, { recursive: true, force: true });
  });

  it('saves the image to the public dir and links it', async () => {
    const result = await generateImage({ sessionId: 'sid', workingDir }, baseInput);

    expect(result.path).toMatch(
      new RegExp(`^${workspace.dir}/public/images/a-red-circle-[0-9a-f]{8}\\.png$`)
    );
    expect(result.url).toBe(`https://files.example/sid/images/${path.basename(result.path)}`);
    expect(result).toMatchObject({ size: '1024x1024', revisedPrompt: 'A red circle' });
    expect(await readFile(result.path)).toEqual(PNG_BYTES);

    const [request] = proxy.requests;
    expect(request.url).toBe('/v1/responses');
    expect(request.headers.authorization).toBe('Bearer sk-proxy');
    expect(request.json).toMatchObject({ model: 'openai/gpt-6-luna', stream: true });
  });

  it('saves to output_path relative to the working dir, without a link outside the public dir', async () => {
    const result = await generateImage(
      { sessionId: 'sid', workingDir },
      { ...baseInput, outputPath: 'assets/logo.png' }
    );
    expect(result.path).toBe(path.join(workingDir, 'assets/logo.png'));
    expect(result.url).toBeNull();
    expect(await readFile(result.path)).toEqual(PNG_BYTES);
  });

  it('omits the link when public files are off', async () => {
    mockEnv.PUBLIC_FILES_URL = undefined;
    try {
      const result = await generateImage({ sessionId: 'sid', workingDir }, baseInput);
      expect(result.url).toBeNull();
    } finally {
      mockEnv.PUBLIC_FILES_URL = 'https://files.example/';
    }
  });

  it('sends input images as data URLs', async () => {
    await writeFile(path.join(workingDir, 'photo.jpg'), Buffer.from('jpeg'));
    await generateImage(
      { sessionId: 'sid', workingDir },
      { ...baseInput, inputImages: ['photo.jpg'] }
    );
    expect(proxy.requests[0].json).toMatchObject({
      input: [
        {
          content: [
            { type: 'input_text' },
            {
              type: 'input_image',
              image_url: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`,
            },
          ],
        },
      ],
    });
  });

  it('rejects an input image of an unsupported type without calling the proxy', async () => {
    await writeFile(path.join(workingDir, 'logo.svg'), '<svg/>');
    await expect(
      generateImage({ sessionId: 'sid', workingDir }, { ...baseInput, inputImages: ['logo.svg'] })
    ).rejects.toThrow('input images must be PNG, JPEG, WebP or GIF');
    expect(proxy.requests).toHaveLength(0);
  });

  it('surfaces a proxy error', async () => {
    proxy.status = 400;
    proxy.body = '{"error":{"message":"no healthy deployments"}}';
    await expect(generateImage({ sessionId: 'sid', workingDir }, baseInput)).rejects.toThrow(
      /HTTP 400.*no healthy deployments/
    );
  });

  it('surfaces a failed generation', async () => {
    proxy.body = `data: ${JSON.stringify({
      type: 'response.failed',
      response: { error: { message: 'Usage limit reached' } },
    })}\n\n`;
    await expect(generateImage({ sessionId: 'sid', workingDir }, baseInput)).rejects.toThrow(
      'Usage limit reached'
    );
  });

  it('links an output_path inside the public dir', async () => {
    const result = await generateImage(
      { sessionId: 'sid', workingDir },
      { ...baseInput, outputPath: '../public/diagrams/flow chart.png' }
    );
    expect(result.url).toBe('https://files.example/sid/diagrams/flow%20chart.png');
  });

  it('rejects input images over the total size limit without calling the proxy', async () => {
    await writeFile(path.join(workingDir, 'big.png'), Buffer.alloc(41 * 1024 * 1024));
    await expect(
      generateImage({ sessionId: 'sid', workingDir }, { ...baseInput, inputImages: ['big.png'] })
    ).rejects.toThrow('the limit is 40 MB');
    expect(proxy.requests).toHaveLength(0);
  });

  it('stops and writes nothing when the tool call is aborted mid-request', async () => {
    proxy.hang = true;
    const controller = new AbortController();
    const pending = generateImage({ sessionId: 'sid', workingDir }, baseInput, controller.signal);
    await vi.waitFor(() => expect(proxy.requests).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    await expect(readdir(path.join(workspace.dir, 'public', 'images'))).rejects.toThrow();
  });
});
