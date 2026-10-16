import path from 'path';
import { z } from 'zod';
import { GPT_AGENT_MODELS } from './llm-proxy';

/**
 * Pure parts of the generate_image built-in tool (doc/settings.md "Image
 * Generation"). Each model names a provider kind, so another provider is a new
 * entry plus a case in the service.
 */

interface ImageModel {
  /** OpenAI's hosted image_generation tool, called through the LLM proxy's /v1/responses. */
  kind: 'responses-tool';
  /** The text model that calls the tool; its routing decides who pays. */
  proxyModel: string;
}

export const IMAGE_MODELS = {
  // A ChatGPT plan picks the image model itself, ignoring any `model` on the tool.
  'gpt-image': { kind: 'responses-tool', proxyModel: GPT_AGENT_MODELS.luna },
} as const satisfies Record<string, ImageModel>;

export type ImageModelName = keyof typeof IMAGE_MODELS;
export const IMAGE_MODEL_NAMES = Object.keys(IMAGE_MODELS) as [ImageModelName, ...ImageModelName[]];

export const IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const;
export const IMAGE_BACKGROUNDS = ['auto', 'opaque', 'transparent'] as const;

export const MAX_INPUT_IMAGES = 8;
/** OpenAI rejects larger requests; checked before encoding so the error is clear. */
export const MAX_INPUT_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;

export const GENERATE_IMAGE_TOOL_DESCRIPTION = `Generate an image from a text prompt, or edit images by passing them as input_images. Saves the image and returns its path (and a browser link when the session has a public directory). Each call makes one image and takes a minute or so. Relative paths are relative to your working directory. Models:
- gpt-image: OpenAI's ChatGPT Images, good at text in images, diagrams and photorealism.
Write a detailed prompt: subject, composition, style, and any exact text to render. Read the saved file to check the result.`;

/** Mime type for an input image, by extension; null for formats the tool can't take. */
export function imageMimeType(filePath: string): string | null {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return null;
  }
}

export interface ImageToolOptions {
  size: (typeof IMAGE_SIZES)[number];
  background: (typeof IMAGE_BACKGROUNDS)[number];
}

/** A Responses API request that makes the model call the image tool exactly once. */
export function responsesImageRequest(
  proxyModel: string,
  prompt: string,
  inputImageUrls: string[],
  options: ImageToolOptions
) {
  return {
    model: proxyModel,
    stream: true,
    instructions:
      'Call the image generation tool once with the user’s request, preserving its details.',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...inputImageUrls.map((url) => ({ type: 'input_image', image_url: url })),
        ],
      },
    ],
    tools: [{ type: 'image_generation', size: options.size, background: options.background }],
    tool_choice: { type: 'image_generation' },
  };
}

const imageCallSchema = z.object({
  type: z.literal('image_generation_call'),
  status: z.string().optional(),
  result: z.string().nullish(),
  revised_prompt: z.string().nullish(),
  size: z.string().optional(),
  output_format: z.string().optional(),
});

const textMessageSchema = z.object({
  type: z.literal('message'),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
});

const errorSchema = z.object({ message: z.string() });

const streamEventSchema = z.union([
  z.object({ type: z.literal('response.output_item.done'), item: z.unknown() }),
  z.object({
    type: z.enum(['response.failed', 'response.incomplete']),
    response: z.object({
      error: errorSchema.nullish(),
      incomplete_details: z.object({ reason: z.string() }).nullish(),
    }),
  }),
  z.object({ type: z.literal('error'), message: z.string().optional() }),
  // A proxy error sent in place of the stream.
  z.object({ error: errorSchema }),
]);

export interface GeneratedImage {
  base64: string;
  revisedPrompt?: string;
  size?: string;
  format: string;
}

/**
 * The image in a Responses API event stream (SSE text), or why there is none.
 * When the model answers in text instead (a refusal), the error carries that text.
 */
export function parseImageStream(sse: string): { image: GeneratedImage } | { error: string } {
  const replies: string[] = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let json: unknown;
    try {
      json = JSON.parse(line.slice('data:'.length));
    } catch {
      continue;
    }
    const event = streamEventSchema.safeParse(json);
    if (!event.success) continue;
    const data = event.data;
    if ('error' in data) return { error: data.error.message };
    if (data.type === 'error') return { error: data.message ?? 'Image generation failed' };
    if (data.type !== 'response.output_item.done') {
      const { error, incomplete_details } = data.response;
      return {
        error:
          error?.message ?? `Image generation stopped: ${incomplete_details?.reason ?? 'failed'}`,
      };
    }
    const call = imageCallSchema.safeParse(data.item);
    if (call.success) {
      if (!call.data.result) return { error: `Image generation ${call.data.status ?? 'failed'}` };
      return {
        image: {
          base64: call.data.result,
          revisedPrompt: call.data.revised_prompt ?? undefined,
          size: call.data.size,
          format: call.data.output_format ?? 'png',
        },
      };
    }
    const message = textMessageSchema.safeParse(data.item);
    if (message.success) {
      replies.push(...message.data.content.flatMap((part) => (part.text ? [part.text] : [])));
    }
  }
  const reply = replies.join('\n').trim();
  return {
    error: reply
      ? `The model replied instead of generating an image: ${reply}`
      : 'The model did not generate an image',
  };
}

/** A file name from the prompt's first words, unique by `suffix`. */
export function imageFileName(prompt: string, suffix: string, format: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${slug || 'image'}-${suffix}.${format}`;
}
