/**
 * Copy text that may still be loading. iOS Safari only lets a page write the
 * clipboard during the user's tap, so a write after an `await` fails there;
 * handing `ClipboardItem` the pending text keeps the write inside the tap.
 * Browsers without `ClipboardItem` get a plain write once the text arrives.
 */
export async function writeClipboardText(text: string | Promise<string>): Promise<void> {
  if (typeof text === 'string') return navigator.clipboard.writeText(text);
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) {
    return navigator.clipboard.writeText(await text);
  }
  const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
  return navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
}
