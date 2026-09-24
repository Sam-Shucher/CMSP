import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePollWhileVisible } from './usePollWhileVisible';
import { setTabVisibility, resetTabVisibility } from '../test/visibility';

const EVERY_MS = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  resetTabVisibility();
});

describe('usePollWhileVisible', () => {
  it('checks on the interval while the tab is showing', async () => {
    const check = vi.fn();
    renderHook(() => usePollWhileVisible(check, EVERY_MS));

    await act(async () => { await vi.advanceTimersByTimeAsync(EVERY_MS * 3); });

    expect(check).toHaveBeenCalledTimes(3);
  });

  // A tab left open in the background all day was a request a minute, every
  // minute, to the Pi — for a count nobody could see.
  it('stops checking while the tab is hidden', async () => {
    const check = vi.fn();
    renderHook(() => usePollWhileVisible(check, EVERY_MS));

    act(() => { setTabVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(EVERY_MS * 10); });

    expect(check).not.toHaveBeenCalled();
  });

  // A phone coming back from sleep shouldn't show a minute-old count.
  it('checks at once when the tab is shown again, then carries on the interval', async () => {
    const check = vi.fn();
    renderHook(() => usePollWhileVisible(check, EVERY_MS));
    act(() => { setTabVisibility('hidden'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(EVERY_MS * 5); });

    act(() => { setTabVisibility('visible'); });
    expect(check).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(EVERY_MS); });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does not start polling when opened in a background tab, until it is shown', async () => {
    setTabVisibility('hidden');
    const check = vi.fn();
    renderHook(() => usePollWhileVisible(check, EVERY_MS));

    await act(async () => { await vi.advanceTimersByTimeAsync(EVERY_MS * 3); });
    expect(check).not.toHaveBeenCalled();

    act(() => { setTabVisibility('visible'); });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('stops for good once unmounted, visible or not', async () => {
    const check = vi.fn();
    const { unmount } = renderHook(() => usePollWhileVisible(check, EVERY_MS));
    unmount();

    await act(async () => { await vi.advanceTimersByTimeAsync(EVERY_MS * 3); });
    act(() => { setTabVisibility('hidden'); });
    act(() => { setTabVisibility('visible'); });

    expect(check).not.toHaveBeenCalled();
  });
});
