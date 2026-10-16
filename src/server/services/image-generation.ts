import { mkdir, readFile, stat, writeFile } from 'fs/promises';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { env } from '@/lib/env';
import {
  IMAGE_MODELS,
  imageFileName,
  imageMimeType,
  parseImageStream,
  responsesImageRequest,
  type ImageModelName,
  type ImageToolOptions,
} from '@/lib/image-generation';
import { createLogger } from '@/lib/logger';
import { publicFilesUrl } from '@/lib/public-files';
import { getSessionPublicDir } from './public-dir';

const log = createLogger('image-generation');

/** Larger inputs are rejected by OpenAI anyway, and would sit in memory as base64. */
const MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export interface ImageToolContext {
  sessionId: string;
  workingDir: string;
}

export interface GenerateImageInput extends ImageToolOptions {
  model: ImageModelName;
  prompt: string;
  inputImages: string[];
  /** Absolute or relative to the working dir; defaults to the session's public dir. */
  outputPath?: string;
}

export interface GenerateImageResult {
  path: string;
  url: string | null;
  size?: string;
  revisedPrompt?: string;
}

async function imageDataUrl(workingDir: string, file: string): Promise<string> {
  const resolved = path.resolve(workingDir, file);
  const mime = imageMimeType(resolved);
  if (!mime) throw new Error(`${file}: input images must be PNG, JPEG, WebP or GIF`);
  if ((await stat(resolved)).size > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(`${file}: input images must be at most 20 MB`);
  }
  return `data:${mime};base64,${(await readFile(resolved)).toString('base64')}`;
}

async function callResponsesImageTool(
  proxyModel: string,
  input: GenerateImageInput,
  inputImageUrls: string[],
  signal: AbortSignal
) {
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
  const body = await response.text();
  if (!response.ok)
    throw new Error(`LLM proxy returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = parseImageStream(body);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.image;
}

export async function generateImage(
  ctx: ImageToolContext,
  input: GenerateImageInput,
  signal?: AbortSignal
): Promise<GenerateImageResult> {
  const inputImageUrls = await Promise.all(
    input.inputImages.map((file) => imageDataUrl(ctx.workingDir, file))
  );
  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);
  const spec = IMAGE_MODELS[input.model];
  log.info('Generating image', { sessionId: ctx.sessionId, model: input.model });
  const image = await callResponsesImageTool(spec.proxyModel, input, inputImageUrls, requestSignal);

  const fileName = imageFileName(input.prompt, randomBytes(3).toString('hex'), image.format);
  const publicDir = getSessionPublicDir(ctx.sessionId);
  const outputPath = input.outputPath
    ? path.resolve(ctx.workingDir, input.outputPath)
    : path.join(publicDir, 'images', fileName);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(image.base64, 'base64'));

  const relativeToPublic = path.relative(publicDir, outputPath);
  const inPublicDir = !relativeToPublic.startsWith('..') && !path.isAbsolute(relativeToPublic);
  const url =
    env.PUBLIC_FILES_URL && inPublicDir
      ? publicFilesUrl(env.PUBLIC_FILES_URL, ctx.sessionId) +
        relativeToPublic.split(path.sep).map(encodeURIComponent).join('/')
      : null;
  return { path: outputPath, url, size: image.size, revisedPrompt: image.revisedPrompt };
}
