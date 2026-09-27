import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { resetEnvCache } from '@/lib/env';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// The routes import @/lib/prisma at module load, so import them only after the test DB is configured.
let POST: typeof import('./route').POST;
let GET: typeof import('./[id]/route').GET;

const TOKEN = 'tts-route-test-token';
const FRAME_HEADER = [0xff, 0xf3, 0x84, 0xc4];

/** One 192-byte MP3 frame; `tag` makes it a Xing header frame. */
function frame(fill: number, tag?: string): number[] {
  const bytes = [...FRAME_HEADER, ...new Array<number>(188).fill(fill)];
  if (tag) [...tag].forEach((c, i) => (bytes[13 + i] = c.charCodeAt(0)));
  return bytes;
}

interface ProviderRequest {
  authorization: string | undefined;
  body: { model: string; input: string; voice: string; speed: number; response_format: string };
}

const providerRequests: ProviderRequest[] = [];
let provider: Server;

beforeAll(async () => {
  provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as ProviderRequest['body'];
      providerRequests.push({ authorization: req.headers.authorization, body });
      if (req.url !== '/v1/audio/speech' || body.input.includes('FAIL')) {
        res.writeHead(401).end('bad key');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.from([...frame(0, 'Xing'), ...frame(body.input.length % 256)]));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const { port } = provider.address() as AddressInfo;

  process.env.TTS_BASE_URL = `http://127.0.0.1:${port}/v1/`;
  process.env.TTS_API_KEY = 'provider-key';
  await setupTestDb();
  ({ POST } = await import('./route'));
  ({ GET } = await import('./[id]/route'));
});

beforeEach(async () => {
  providerRequests.length = 0;
  await clearTestDb();
  await testPrisma.authSession.create({
    data: { token: TOKEN, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
});

afterAll(async () => {
  delete process.env.TTS_BASE_URL;
  delete process.env.TTS_API_KEY;
  resetEnvCache();
  await new Promise((resolve) => provider.close(resolve));
  await clearTestDb();
  await teardownTestDb();
});

function speak(body: unknown, token: string | null = TOKEN): Promise<Response> {
  return POST(
    new Request('http://localhost/api/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

function fetchAudio(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const id = url.split('/').pop() ?? '';
  return GET(new Request(`http://localhost${url}`, { headers }), {
    params: Promise.resolve({ id }),
  });
}

async function speakUrl(text: string): Promise<string> {
  const res = await speak({ text });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  return url;
}

describe('POST /api/tts', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await speak({ text: 'Hi.' }, null)).status).toBe(401);
  });

  it('rejects empty text', async () => {
    expect((await speak({ text: '   ' })).status).toBe(400);
    expect((await speak({})).status).toBe(400);
  });

  it('synthesizes MP3 with the saved voice and speed', async () => {
    await testPrisma.globalSettings.create({
      data: { id: 'global', ttsVoice: 'bm_george', ttsSpeed: 1.25 },
    });
    const url = await speakUrl('Hello there.');

    expect(url).toMatch(/^\/api\/tts\/[A-Za-z0-9_-]{43}$/);
    expect(providerRequests).toEqual([
      {
        authorization: 'Bearer provider-key',
        body: {
          model: 'hexgrad/kokoro-82m',
          input: 'Hello there.',
          voice: 'bm_george',
          speed: 1.25,
          response_format: 'mp3',
        },
      },
    ]);
  });

  it('reports a provider failure', async () => {
    const res = await speak({ text: 'FAIL please.' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain('401');
  });
});

describe('GET /api/tts/[id]', () => {
  it('serves the audio without its Xing frame, and ranges of it', async () => {
    const url = await speakUrl('Hello again.');
    const expected = frame('Hello again.'.length);

    const whole = await fetchAudio(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/mpeg');
    expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual(expected);

    const probe = await fetchAudio(url, { range: 'bytes=0-1' });
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${expected.length}`);
    expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual(expected.slice(0, 2));
  });

  it('reuses the synthesis for a repeated request', async () => {
    const first = await speakUrl('Same words.');
    const second = await speakUrl('Same words.');
    expect(second).toBe(first);
    expect(providerRequests).toHaveLength(1);
  });

  it('returns 404 for unknown and malformed ids', async () => {
    expect((await fetchAudio(`/api/tts/${'x'.repeat(43)}`)).status).toBe(404);
    expect((await fetchAudio('/api/tts/short')).status).toBe(404);
  });
});
