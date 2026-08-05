import { describe, it, expect } from 'vitest';
import {
  mergeCancelledText,
  mergeCancelledAttachments,
  type CancelledPrompt,
} from './cancelled-prompt';
import type { UploadedAttachment } from './attachments';

const att = (storedName: string): UploadedAttachment => ({
  name: storedName.replace(/^[0-9a-f]{8}-/, ''),
  storedName,
  path: `/w/uploads/${storedName}`,
});

const prompt = (text: string, attachments: UploadedAttachment[] = []): CancelledPrompt => ({
  text,
  attachments,
});

describe('mergeCancelledText', () => {
  it('fills an empty composer', () => {
    expect(mergeCancelledText('', [prompt('recalled')])).toBe('recalled');
  });

  it('puts recalled text before what the user typed since', () => {
    expect(mergeCancelledText('newer', [prompt('older')])).toBe('older\n\nnewer');
  });

  it('keeps several recalled prompts in push order', () => {
    expect(mergeCancelledText('', [prompt('one'), prompt('two')])).toBe('one\n\ntwo');
  });

  it('leaves the composer untouched when nothing was recalled', () => {
    expect(mergeCancelledText('typing', [])).toBe('typing');
  });

  it('ignores an empty recalled text (an attachment-only message)', () => {
    expect(mergeCancelledText('typing', [prompt('', [att('aaaa1111-doc.md')])])).toBe('typing');
  });
});

describe('mergeCancelledAttachments', () => {
  it('restores recalled attachments ahead of the composer’s own', () => {
    const current = [att('bbbb2222-new.png')];
    const result = mergeCancelledAttachments(current, [prompt('x', [att('aaaa1111-doc.md')])]);
    expect(result.map((a) => a.storedName)).toEqual(['aaaa1111-doc.md', 'bbbb2222-new.png']);
  });

  it('does not duplicate one the user already re-attached', () => {
    const current = [att('aaaa1111-doc.md')];
    const result = mergeCancelledAttachments(current, [prompt('x', [att('aaaa1111-doc.md')])]);
    expect(result.map((a) => a.storedName)).toEqual(['aaaa1111-doc.md']);
  });

  it('dedupes across several recalled prompts', () => {
    const shared = att('aaaa1111-doc.md');
    const result = mergeCancelledAttachments(
      [],
      [prompt('one', [shared]), prompt('two', [shared, att('cccc3333-b.txt')])]
    );
    expect(result.map((a) => a.storedName)).toEqual(['aaaa1111-doc.md', 'cccc3333-b.txt']);
  });

  it('returns a copy when nothing was recalled', () => {
    const current = [att('aaaa1111-doc.md')];
    const result = mergeCancelledAttachments(current, []);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });
});
