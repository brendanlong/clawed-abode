/** Poll `fn` until it reports true, or throw when `timeoutMs` elapses. */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() >= end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}
