/**
 * One value per process, however many bundled copies of the calling module exist.
 * Next compiles instrumentation and the app routes as separate module graphs, so
 * module-level state that both reach must live here (src/server/services/CLAUDE.md).
 */
export function processSingleton<T>(key: string, create: () => T): T {
  const store = globalThis as unknown as Record<symbol, T | undefined>;
  const symbol = Symbol.for(`clawed-abode:${key}`);
  return (store[symbol] ??= create());
}
