import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CartLink, { POLL_INTERVAL_MS } from './CartLink';
import { CART_CHANGED_EVENT } from '../api/client';
import { jsonResponse } from '../test/apiMock';

// One cart row per mini — the badge only cares how many there are.
function cartOf(count: number): { miniId: number; name: string; image: null; ownerId: number }[] {
  return Array.from({ length: count }, (_unused, i) => ({
    miniId: i + 1, name: `Mini ${i + 1}`, image: null, ownerId: 2,
  }));
}

// Answers /api/cart with each given size in turn, repeating the last one.
function serveCarts(...sizes: number[]): ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(() => {
    const size = sizes[Math.min(call++, sizes.length - 1)];
    return Promise.resolve(jsonResponse(cartOf(size)));
  });
}

function renderCartLink(): void {
  render(<MemoryRouter><CartLink /></MemoryRouter>);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CartLink — the Cart link in the nav', () => {
  it('shows no count while the cart is empty', async () => {
    vi.stubGlobal('fetch', serveCarts(0));
    renderCartLink();

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/cart', expect.anything()));
    expect(screen.getByRole('link', { name: 'Cart' })).toBeInTheDocument();
    expect(screen.getByTestId('cart-count-status')).toHaveTextContent('');
    expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument();
  });

  it('pops up the number of minis once there is something in the cart', async () => {
    vi.stubGlobal('fetch', serveCarts(3));
    renderCartLink();

    expect(await screen.findByTestId('cart-count')).toHaveTextContent('3');
  });

  it('counts one mini in the singular, and more in the plural, for a screen reader', async () => {
    vi.stubGlobal('fetch', serveCarts(1));
    renderCartLink();

    await waitFor(() => expect(screen.getByTestId('cart-count-status')).toHaveTextContent('1 mini in your cart'));
  });

  it('says "minis" when there is more than one', async () => {
    vi.stubGlobal('fetch', serveCarts(2));
    renderCartLink();

    await waitFor(() => expect(screen.getByTestId('cart-count-status')).toHaveTextContent('2 minis in your cart'));
  });

  // Three end-to-end selectors and the phone layout test look the link up by
  // the name "Cart" — the count is decorative, announced separately.
  it('leaves the link itself named just "Cart"', async () => {
    vi.stubGlobal('fetch', serveCarts(4));
    renderCartLink();

    await screen.findByTestId('cart-count');
    expect(screen.getByRole('link', { name: 'Cart' })).toHaveAttribute('href', '/cart');
    expect(screen.getByTestId('cart-count')).toHaveAttribute('aria-hidden', 'true');
  });

  it('updates as soon as a page says the cart changed', async () => {
    vi.stubGlobal('fetch', serveCarts(1, 2));
    renderCartLink();
    await waitFor(() => expect(screen.getByTestId('cart-count')).toHaveTextContent('1'));

    act(() => { window.dispatchEvent(new Event(CART_CHANGED_EVENT)); });

    await waitFor(() => expect(screen.getByTestId('cart-count')).toHaveTextContent('2'));
  });

  it('drops the count again when the cart is emptied by a checkout', async () => {
    vi.stubGlobal('fetch', serveCarts(2, 0));
    renderCartLink();
    await waitFor(() => expect(screen.getByTestId('cart-count')).toHaveTextContent('2'));

    act(() => { window.dispatchEvent(new Event(CART_CHANGED_EVENT)); });

    await waitFor(() => expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument());
  });

  it('checks again on its own, so a cart filled in another tab shows up here', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', serveCarts(0, 2));
    renderCartLink();
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });

    expect(screen.getByTestId('cart-count')).toHaveTextContent('2');
  });

  it('stops checking once it leaves the page', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', serveCarts(1));
    const { unmount } = render(<MemoryRouter><CartLink /></MemoryRouter>);
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    const before = (fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    window.dispatchEvent(new Event(CART_CHANGED_EVENT));

    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('still shows a working link if the cart can\'t be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'nope' }, { ok: false, status: 500 }))));
    renderCartLink();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: 'Cart' })).toBeInTheDocument();
    expect(screen.queryByTestId('cart-count')).not.toBeInTheDocument();
  });

  it('caps a silly number so it can\'t stretch the nav', async () => {
    vi.stubGlobal('fetch', serveCarts(120));
    renderCartLink();

    expect(await screen.findByTestId('cart-count')).toHaveTextContent('99+');
  });
});
