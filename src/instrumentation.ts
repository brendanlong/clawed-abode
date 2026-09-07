/**
 * Next.js instrumentation entry. Compiled for BOTH the Node and Edge runtimes, so
 * it must stay free of Node-only imports; the real work lives in
 * instrumentation-node.ts and is loaded only under the Node runtime.
 * See: https://nextjs.org/docs/app/guides/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('./instrumentation-node');
    await registerNode();
  }
}
