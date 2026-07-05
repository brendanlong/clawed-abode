import { createContext } from '@/server/trpc';
import { prisma } from '@/lib/prisma';
import { saveUploadedFile, MAX_UPLOAD_BYTES } from '@/server/services/uploads';
import type { UploadedAttachment } from '@/lib/attachments';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('upload-route');

/**
 * Accepts multipart/form-data uploads (fields: `sessionId`, one or more `files`)
 * and stores them outside the repo where Claude can read them. Returns the saved
 * attachments; the client holds these and passes their `storedName`s to
 * `claude.send`, which prefixes their paths onto the next user message.
 *
 * A dedicated route (rather than a tRPC mutation) is used so binary file bodies
 * stream through `FormData` instead of being base64-inflated through superjson.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = await createContext({ headers: request.headers });
  if (!ctx.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    log.warn('Failed to parse upload form data', { error: toError(err).message });
    return Response.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const sessionId = formData.get('sessionId');
  if (typeof sessionId !== 'string' || !sessionId) {
    return Response.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true },
  });
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json({ error: 'No files provided' }, { status: 400 });
  }

  const attachments: UploadedAttachment[] = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: `File "${file.name}" exceeds the maximum size of ${MAX_UPLOAD_BYTES} bytes` },
        { status: 413 }
      );
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    attachments.push(await saveUploadedFile(sessionId, file.name, buffer));
  }

  log.info('Handled file upload', { sessionId, count: attachments.length });
  return Response.json({ attachments });
}
