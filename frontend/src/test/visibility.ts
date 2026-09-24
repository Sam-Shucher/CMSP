// Switches the tab between shown and hidden, the way a browser does when
// someone changes tab, minimises the window, or locks their phone. jsdom's
// tab is always visible otherwise.

export function setTabVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}

// Back to jsdom's own (always visible) values, for the next test.
export function resetTabVisibility(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
  delete (document as { hidden?: unknown }).hidden;
}
