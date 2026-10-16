import { describe, expect, it } from 'vitest';
import {
  imageFileName,
  imageMimeType,
  parseImageStream,
  responsesImageRequest,
} from './image-generation';

function sse(...events: unknown[]): string {
  return [...events.map((event) => `data: ${JSON.stringify(event)}\n`), 'data: [DONE]\n'].join(
    '\n'
  );
}

const imageItem = {
  type: 'image_generation_call',
  status: 'completed',
  result: 'iVBORw0KGgo=',
  revised_prompt: 'A cat on a mat',
  size: '1024x1024',
  output_format: 'png',
};

describe('parseImageStream', () => {
  it('returns the generated image, skipping other events', () => {
    const stream = sse(
      { type: 'response.created', response: {} },
      { type: 'response.output_item.done', item: imageItem },
      { type: 'response.output_item.done', item: { type: 'message', content: [] } },
      { type: 'response.completed', response: {} }
    );
    expect(parseImageStream(stream)).toEqual({
      image: {
        base64: 'iVBORw0KGgo=',
        revisedPrompt: 'A cat on a mat',
        size: '1024x1024',
        format: 'png',
      },
    });
  });

  it('reports a failed response', () => {
    const stream = sse({
      type: 'response.failed',
      response: { error: { message: 'Usage limit reached' } },
    });
    expect(parseImageStream(stream)).toEqual({ error: 'Usage limit reached' });
  });

  it('reports a stream error event', () => {
    expect(parseImageStream(sse({ type: 'error', message: 'Bad request' }))).toEqual({
      error: 'Bad request',
    });
  });

  it('reports a response that made no image', () => {
    const stream = sse({
      type: 'response.output_item.done',
      item: { type: 'message', content: [{ type: 'output_text', text: "I can't draw that" }] },
    });
    expect(parseImageStream(stream)).toEqual({ error: 'The model did not generate an image' });
  });

  it('ignores an image call without a result', () => {
    const stream = sse({
      type: 'response.output_item.done',
      item: { ...imageItem, result: '' },
    });
    expect(parseImageStream(stream)).toEqual({ error: 'The model did not generate an image' });
  });
});

describe('responsesImageRequest', () => {
  it('forces one image tool call with the options and input images', () => {
    const request = responsesImageRequest(
      'openai/gpt-6-luna',
      'Edit this',
      ['data:image/png;base64,AA'],
      {
        size: '1536x1024',
        background: 'transparent',
      }
    );
    expect(request).toMatchObject({
      model: 'openai/gpt-6-luna',
      stream: true,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Edit this' },
            { type: 'input_image', image_url: 'data:image/png;base64,AA' },
          ],
        },
      ],
      tools: [{ type: 'image_generation', size: '1536x1024', background: 'transparent' }],
      tool_choice: { type: 'image_generation' },
    });
  });
});

describe('imageFileName', () => {
  it('slugs the start of the prompt', () => {
    expect(imageFileName('A Cat, sitting on a mat!', 'abc123', 'png')).toBe(
      'a-cat-sitting-on-a-mat-abc123.png'
    );
  });

  it('cuts long prompts without a trailing dash', () => {
    expect(imageFileName('one two three four five six seven eight nine ten', 'x', 'png')).toBe(
      'one-two-three-four-five-six-seven-eight-x.png'
    );
  });

  it('falls back when the prompt has no usable characters', () => {
    expect(imageFileName('日本の猫', 'x', 'webp')).toBe('image-x.webp');
  });
});

describe('imageMimeType', () => {
  it('maps supported extensions case-insensitively', () => {
    expect(imageMimeType('/a/b.PNG')).toBe('image/png');
    expect(imageMimeType('c.jpeg')).toBe('image/jpeg');
    expect(imageMimeType('c.jpg')).toBe('image/jpeg');
    expect(imageMimeType('d.webp')).toBe('image/webp');
    expect(imageMimeType('e.gif')).toBe('image/gif');
  });

  it('rejects anything else', () => {
    expect(imageMimeType('f.svg')).toBeNull();
    expect(imageMimeType('noext')).toBeNull();
  });
});
