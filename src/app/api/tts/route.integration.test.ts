import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { resetEnvCache } from '@/lib/env';
import { setupTestDb, teardownTestDb, testPrisma, clearTestDb } from '@/test/setup-test-db';

// The route imports @/lib/prisma at module load, so import it only after the test DB is configured.
let POST: typeof import('./route').POST;

const TOKEN = 'tts-route-test-token';

/** The provider's PCM for `input`: two samples, sent as a split read. */
function pcmFor(input: string): number[] {
  return [input.length % 256, 0, 1, 0];
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
      const pcm = pcmFor(body.input);
      res.write(Buffer.from(pcm.slice(0, 1)));
      res.end(Buffer.from(pcm.slice(1)));
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const { port } = provider.address() as AddressInfo;

  process.env.TTS_BASE_URL = `http://127.0.0.1:${port}/v1/`;
  process.env.TTS_API_KEY = 'provider-key';
  await setupTestDb();
  ({ POST } = await import('./route'));
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

async function speakPcm(text: string): Promise<number[]> {
  const res = await speak({ text });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  return [...new Uint8Array(await res.arrayBuffer())];
}

describe('POST /api/tts', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await speak({ text: 'Hi.' }, null)).status).toBe(401);
  });

  it('rejects empty text', async () => {
    expect((await speak({ text: '   ' })).status).toBe(400);
    expect((await speak({})).status).toBe(400);
  });

  it('streams PCM synthesized with the saved voice and speed', async () => {
    await testPrisma.globalSettings.create({
      data: { id: 'global', ttsVoice: 'bm_george', ttsSpeed: 1.25 },
    });
    expect(await speakPcm('Hello there.')).toEqual(pcmFor('Hello there.'));

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

  it('reuses the synthesis for a repeated request', async () => {
    const first = await speakPcm('Same words. Twice over.');
    expect(await speakPcm('Same words. Twice over.')).toEqual(first);
    expect(first).toEqual([...pcmFor('Same words.'), ...pcmFor('Twice over.')]);
    expect(providerRequests).toHaveLength(2);
  });
});
