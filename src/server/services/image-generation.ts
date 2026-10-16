import { mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { env } from '@/lib/env';
import {
  IMAGE_MODELS,
  imageFileName,
  imageMimeType,
  MAX_INPUT_IMAGE_TOTAL_BYTES,
  parseImageStream,
  responsesImageRequest,
  type GeneratedImage,
  type ImageModelName,
  type ImageToolOptions,
} from '@/lib/image-generation';
import { createLogger } from '@/lib/logger';
import { publicFilesUrl } from '@/lib/public-files';
import { getSessionPublicDir } from './public-dir';

const log = createLogger('image-generation');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export interface ImageToolContext {
  sessionId: string;
  workingDir: string;
}

export interface GenerateImageInput extends ImageToolOptions {
  model: ImageModelName;
  prompt: string;
  inputImages: string[];
  /** Absolute, `~/`, or relative to the working dir; defaults to the session's public dir. */
  outputPath?: string;
}

export interface GenerateImageResult {
  path: string;
  url: string | null;
  size?: string;
  revisedPrompt?: string;
}

function resolveAgentPath(workingDir: string, file: string): string {
  return file === '~' || file.startsWith('~/')
    ? path.join(homedir(), file.slice(1))
    : path.resolve(workingDir, file);
}

async function inputImageDataUrls(workingDir: string, files: string[]): Promise<string[]> {
  const images = await Promise.all(
    files.map(async (file) => {
      const mime = imageMimeType(file);
      if (!mime) throw new Error(`${file}: input images must be PNG, JPEG, WebP or GIF`);
      return { mime, bytes: await readFile(resolveAgentPath(workingDir, file)) };
    })
  );
  const total = images.reduce((sum, image) => sum + image.bytes.length, 0);
  if (total > MAX_INPUT_IMAGE_TOTAL_BYTES) {
    throw new Error(
      `Input images total ${Math.ceil(total / 1024 / 1024)} MB; the limit is ${MAX_INPUT_IMAGE_TOTAL_BYTES / 1024 / 1024} MB`
    );
  }
  return images.map(({ mime, bytes }) => `data:${mime};base64,${bytes.toString('base64')}`);
}

async function callResponsesImageTool(
  proxyModel: string,
  input: GenerateImageInput,
  inputImageUrls: string[],
  signal: AbortSignal
): Promise<GeneratedImage> {
  if (!env.LLM_PROXY_URL) throw new Error('No LLM proxy is configured');
  const response = await fetch(`${env.LLM_PROXY_URL.replace(/\/$/, '')}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.LLM_PROXY_KEY ? { Authorization: `Bearer ${env.LLM_PROXY_KEY}` } : {}),
    },
    body: JSON.stringify(responsesImageRequest(proxyModel, input.prompt, inputImageUrls, input)),
    signal,
  });
  // A few MB: the image's base64 appears in two events.
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`LLM proxy returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  const parsed = parseImageStream(body);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.image;
}

/** The public files URL of `file`, or null when it isn't in the session's public dir. */
function publicUrl(sessionId: string, file: string): string | null {
  if (!env.PUBLIC_FILES_URL) return null;
  const relative = path.relative(getSessionPublicDir(sessionId), file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return (
    publicFilesUrl(env.PUBLIC_FILES_URL, sessionId) +
    relative.split(path.sep).map(encodeURIComponent).join('/')
  );
}

export async function generateImage(
  ctx: ImageToolContext,
  input: GenerateImageInput,
  signal?: AbortSignal
): Promise<GenerateImageResult> {
  const inputImageUrls = await inputImageDataUrls(ctx.workingDir, input.inputImages);
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  const spec = IMAGE_MODELS[input.model];
  log.info('Generating image', { sessionId: ctx.sessionId, model: input.model });
  let image: GeneratedImage;
  switch (spec.kind) {
    case 'responses-tool':
      image = await callResponsesImageTool(spec.proxyModel, input, inputImageUrls, requestSignal);
      break;
  }

  const outputPath = input.outputPath
    ? resolveAgentPath(ctx.workingDir, input.outputPath)
    : path.join(
        getSessionPublicDir(ctx.sessionId),
        'images',
        imageFileName(input.prompt, randomBytes(4).toString('hex'), image.format)
      );
  await mkdir(path.dirname(outputPath), { recursive: true });
  // An explicit path may replace a file; a generated name never does.
  await writeFile(outputPath, Buffer.from(image.base64, 'base64'), {
    flag: input.outputPath ? 'w' : 'wx',
  });
  return {
    path: outputPath,
    url: publicUrl(ctx.sessionId, outputPath),
    size: image.size,
    revisedPrompt: image.revisedPrompt,
  };
}
