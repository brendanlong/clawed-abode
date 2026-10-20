import { afterEach, describe, it, expect, vi } from 'vitest';
import { writeClipboardText } from './clipboard';

class FakeClipboardItem {
  readonly items: Record<string, Promise<Blob>>;
  constructor(items: Record<string, Promise<Blob>>) {
    this.items = items;
  }
}

function stubClipboard({ withItems }: { withItems: boolean }) {
  const clipboard = { writeText: vi.fn(async () => {}), write: vi.fn(async () => {}) };
  vi.stubGlobal('navigator', {
    clipboard: withItems ? clipboard : { writeText: clipboard.writeText },
  });
  if (withItems) vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  else vi.stubGlobal('ClipboardItem', undefined);
  return clipboard;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('writeClipboardText', () => {
  it('writes ready text directly', async () => {
    const clipboard = stubClipboard({ withItems: true });
    await writeClipboardText('now');
    expect(clipboard.writeText).toHaveBeenCalledWith('now');
  });

  it('writes pending text within the tap, as a ClipboardItem holding the promise', async () => {
    const clipboard = stubClipboard({ withItems: true });
    let resolve!: (text: string) => void;
    const pending = new Promise<string>((r) => (resolve = r));

    const done = writeClipboardText(pending);

    // Called synchronously, before the text arrives (iOS Safari's requirement).
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    const [[[item]]] = clipboard.write.mock.calls as unknown as [[FakeClipboardItem[]]];
    resolve('later');
    await done;
    expect(await (await item.items['text/plain']).text()).toBe('later');
  });

  it('falls back to writing the text once it arrives without ClipboardItem', async () => {
    const clipboard = stubClipboard({ withItems: false });
    await writeClipboardText(Promise.resolve('later'));
    expect(clipboard.writeText).toHaveBeenCalledWith('later');
  });
});
