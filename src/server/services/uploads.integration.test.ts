import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

// The uploads module reads UPLOADS_DIR at import time, so set it to a temp
// directory before dynamically importing the module.
let uploadDir: string;
let uploads: typeof import('./uploads');

beforeAll(async () => {
  uploadDir = await mkdtemp(path.join(tmpdir(), 'clawed-uploads-test-'));
  process.env.UPLOADS_DIR = uploadDir;
  uploads = await import('./uploads');
});

afterAll(async () => {
  await rm(uploadDir, { recursive: true, force: true });
});

describe('uploads service', () => {
  const sessionId = 'session-123';

  it('saves a file under a per-session directory and returns its path', async () => {
    const data = Buffer.from('hello world');
    const attachment = await uploads.saveUploadedFile(sessionId, 'notes.md', data);

    expect(attachment.name).toBe('notes.md');
    expect(attachment.storedName).toMatch(/^[a-f0-9]{8}-notes\.md$/);
    expect(attachment.path).toBe(path.join(uploadDir, sessionId, attachment.storedName));
    expect(await readFile(attachment.path, 'utf8')).toBe('hello world');
  });

  it('does not overwrite when the same filename is uploaded twice', async () => {
    const a = await uploads.saveUploadedFile(sessionId, 'dup.txt', Buffer.from('first'));
    const b = await uploads.saveUploadedFile(sessionId, 'dup.txt', Buffer.from('second'));

    expect(a.storedName).not.toBe(b.storedName);
    expect(await readFile(a.path, 'utf8')).toBe('first');
    expect(await readFile(b.path, 'utf8')).toBe('second');
  });

  it('sanitizes unsafe file names on disk', async () => {
    const attachment = await uploads.saveUploadedFile(
      sessionId,
      '../../etc/passwd',
      Buffer.from('x')
    );
    // Directory traversal is stripped: stored under the session dir as "passwd".
    expect(attachment.storedName).toMatch(/^[a-f0-9]{8}-passwd$/);
    expect(path.dirname(attachment.path)).toBe(path.join(uploadDir, sessionId));
  });

  it('resolves existing stored names to absolute paths', async () => {
    const attachment = await uploads.saveUploadedFile(sessionId, 'x.md', Buffer.from('x'));
    const resolved = await uploads.resolveUploadPaths(sessionId, [attachment.storedName]);
    expect(resolved).toEqual([attachment.path]);
  });

  it('drops stored names that do not exist', async () => {
    const resolved = await uploads.resolveUploadPaths(sessionId, ['does-not-exist.md']);
    expect(resolved).toEqual([]);
  });

  it('neutralizes path traversal in resolveUploadPaths', async () => {
    // Even if a client tries to escape the session dir, basename collapses it.
    const resolved = await uploads.resolveUploadPaths(sessionId, ['../../../etc/passwd']);
    expect(resolved).toEqual([]);
  });
});
