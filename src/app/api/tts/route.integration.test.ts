import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ADTS, ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { resetEnvCache } from '@/lib/env';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// The routes import @/lib/prisma at module load, so import them only after the test DB is configured.
let POST: typeof import('./route').POST;
let GET: typeof import('./[id]/route').GET;

const TOKEN = 'tts-route-test-token';
/** Seconds of speech the fake provider returns per character of input. */
const SECONDS_PER_CHAR = 0.05;

/** The provider's PCM for `input`: a tone, as 16-bit little-endian mono at 24 kHz. */
function pcmFor(input: string): Buffer {
  const samples = Math.round(input.length * SECONDS_PER_CHAR * 24_000);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
  return pcm;
}

async function decodedSeconds(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  expect(await input.getFormat()).toBe(ADTS);
  return input.computeDuration();
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
      res.writeHead(200, { 'Content-Type': 'audio/pcm' });
      // optimized-kokoro sends nothing when it skips every sentence (e.g. an unsupported language).
      if (body.input.includes('EMPTY')) {
        res.end();
        return;
      }
      // Split mid-sample, as network reads may be.
      const pcm = pcmFor(body.input);
      res.write(pcm.subarray(0, 1001));
      res.end(pcm.subarray(1001));
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

  it('synthesizes PCM with the saved voice and speed', async () => {
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
          response_format: 'pcm',
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
  it('serves the speech as AAC in ADTS, and ranges of it', async () => {
    const text = 'Hello again. And once more.';
    const url = await speakUrl(text);

    const whole = await fetchAudio(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/aac');
    const bytes = new Uint8Array(await whole.arrayBuffer());
    const spoken = ('Hello again.'.length + 'And once more.'.length) * SECONDS_PER_CHAR;
    const seconds = await decodedSeconds(bytes);
    expect(seconds).toBeGreaterThanOrEqual(spoken - 0.001);
    expect(seconds).toBeLessThan(spoken + 0.1);

    const probe = await fetchAudio(url, { range: 'bytes=0-1' });
    expect(probe.status).toBe(206);
    expect(probe.headers.get('content-range')).toBe(`bytes 0-1/${bytes.length}`);
    expect([...new Uint8Array(await probe.arrayBuffer())]).toEqual([...bytes.slice(0, 2)]);
  });

  it('serves an empty file when the provider returns no audio', async () => {
    const url = await speakUrl('EMPTY words.');
    const res = await fetchAudio(url);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
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
