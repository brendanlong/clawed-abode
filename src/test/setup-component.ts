import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom implements neither ResizeObserver nor IntersectionObserver. Radix
// primitives (e.g. the Select popper in ModelOverrideField) construct a
// ResizeObserver, and MessageList uses both — so without stubs a component test
// that mounts them throws `ResizeObserver is not defined`. The throw is async
// (scheduled after mount), so it surfaces as a run-level *unhandled* error that
// fails the whole suite non-deterministically depending on timing — green
// locally, red in CI. Stub both with no-ops.
class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}
globalThis.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver = ObserverStub as unknown as typeof IntersectionObserver;

// Cleanup after each test
afterEach(() => {
  cleanup();
});
