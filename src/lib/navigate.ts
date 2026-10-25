// jsdom's `window.location` can't be stubbed, so tests mock this module instead.
export function navigateTo(url: string): void {
  window.location.assign(url);
}
