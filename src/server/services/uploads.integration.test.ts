import { describe, it, expect, afterAll } from 'vitest';
import { rm, readFile, readdir, utimes, access } from 'fs/promises';
import path from 'path';
import { randomUUID as uuid } from 'node:crypto';
import {
  saveUploadedFile,
  resolveUploadPaths,
  getSessionUploadDir,
  stageUploadedFile,
  claimStagedUploads,
  purgeAbandonedStagedUploads,
} from './uploads';
import { getSessionWorkspacePath } from './worktree-manager';

// Uploads live inside the real session workspace (~/worktrees/{sessionId}/uploads).
// Use a unique session id per run and tear down its whole workspace afterwards.
const sessionId = `uploads-test-${uuid()}`;

afterAll(async () => {
  await rm(getSessionWorkspacePath(sessionId), { recursive: true, force: true });
});

describe('uploads service', () => {
  it('saves a file under the session workspace uploads dir and returns its path', async () => {
    const attachment = await saveUploadedFile(
      sessionId,
      'notes.md',
      new Blob(['hello world']).stream()
    );

    expect(attachment.name).toBe('notes.md');
    expect(attachment.storedName).toMatch(/^[a-f0-9]{8}-notes\.md$/);
    expect(attachment.path).toBe(path.join(getSessionUploadDir(sessionId), attachment.storedName));
    // The uploads dir is a sibling of (not inside) the repo clone.
    expect(path.dirname(getSessionUploadDir(sessionId))).toBe(getSessionWorkspacePath(sessionId));
    expect(await readFile(attachment.path, 'utf8')).toBe('hello world');
  });

  it('does not overwrite when the same filename is uploaded twice', async () => {
    const a = await saveUploadedFile(sessionId, 'dup.txt', new Blob(['first']).stream());
    const b = await saveUploadedFile(sessionId, 'dup.txt', new Blob(['second']).stream());

    expect(a.storedName).not.toBe(b.storedName);
    expect(await readFile(a.path, 'utf8')).toBe('first');
    expect(await readFile(b.path, 'utf8')).toBe('second');
  });

  it('sanitizes unsafe file names on disk', async () => {
    const attachment = await saveUploadedFile(
      sessionId,
      '../../etc/passwd',
      new Blob(['x']).stream()
    );
    // Directory traversal is stripped: stored under the uploads dir as "passwd".
    expect(attachment.storedName).toMatch(/^[a-f0-9]{8}-passwd$/);
    expect(path.dirname(attachment.path)).toBe(getSessionUploadDir(sessionId));
  });

  it('removes the partial file when the body stream fails', async () => {
    const before = await readdir(getSessionUploadDir(sessionId));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
        controller.error(new Error('client disconnected'));
      },
    });

    await expect(saveUploadedFile(sessionId, 'broken.bin', body)).rejects.toThrow(
      'client disconnected'
    );
    expect(await readdir(getSessionUploadDir(sessionId))).toEqual(before);
  });

  it('saves an empty file when there is no body', async () => {
    const attachment = await saveUploadedFile(sessionId, 'empty.txt', null);
    expect(await readFile(attachment.path, 'utf8')).toBe('');
  });

  it('resolves existing stored names to absolute paths', async () => {
    const attachment = await saveUploadedFile(sessionId, 'x.md', new Blob(['x']).stream());
    const resolved = await resolveUploadPaths(sessionId, [attachment.storedName]);
    expect(resolved).toEqual([attachment.path]);
  });

  it('drops stored names that do not exist', async () => {
    const resolved = await resolveUploadPaths(sessionId, ['does-not-exist.md']);
    expect(resolved).toEqual([]);
  });

  it('neutralizes path traversal in resolveUploadPaths', async () => {
    // Even if a client tries to escape the uploads dir, basename collapses it.
    const resolved = await resolveUploadPaths(sessionId, ['../../../etc/passwd']);
    expect(resolved).toEqual([]);
  });
});

// The staging dir is shared with any server on this host, so these tests only
// touch the files they create.
describe('staged uploads', () => {
  const claimSessionId = `uploads-claim-test-${uuid()}`;
  const stagedPaths: string[] = [];

  afterAll(async () => {
    await rm(getSessionWorkspacePath(claimSessionId), { recursive: true, force: true });
    await Promise.all(stagedPaths.map((p) => rm(p, { force: true })));
  });

  async function stage(name: string, body: string) {
    const attachment = await stageUploadedFile(name, new Blob([body]).stream());
    stagedPaths.push(attachment.path);
    return attachment;
  }

  it('moves staged files into the session, once, so the send can resolve them', async () => {
    const staged = await stage('screenshot.png', 'png bytes');

    const claimed = await claimStagedUploads(claimSessionId, [staged.storedName, 'missing.txt']);
    expect(claimed).toEqual([staged.storedName]);
    const [resolved] = await resolveUploadPaths(claimSessionId, claimed);
    expect(await readFile(resolved, 'utf8')).toBe('png bytes');
    await expect(access(staged.path)).rejects.toThrow();

    expect(await claimStagedUploads(`${claimSessionId}-other`, [staged.storedName])).toEqual([]);
  });

  it('cannot claim files from outside the staging dir', async () => {
    const outside = await saveUploadedFile(sessionId, 'secret.txt', new Blob(['s']).stream());
    const traversal = `../${sessionId}/uploads/${outside.storedName}`;
    expect(await claimStagedUploads(claimSessionId, [traversal])).toEqual([]);
    expect(await readFile(outside.path, 'utf8')).toBe('s');
  });

  it('purges only staged files older than a day', async () => {
    const fresh = await stage('fresh.txt', 'f');
    const old = await stage('old.txt', 'o');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(old.path, twoDaysAgo, twoDaysAgo);

    await purgeAbandonedStagedUploads();

    await expect(access(old.path)).rejects.toThrow();
    expect(await readFile(fresh.path, 'utf8')).toBe('f');
  });
});
