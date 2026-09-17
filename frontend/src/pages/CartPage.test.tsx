import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CartPage from './CartPage';
import { CartItem } from '../api/client';
import { jsonResponse, urlOf} from '../test/apiMock';

function item(overrides: Partial<CartItem> = {}): CartItem {
  return {
    miniId: 1, name: 'Dire Wolf', image: null,
    ownerId: 10, ownerName: 'Alice', ownerUsername: 'alice',
    status: 'available',
    ...overrides,
  };
}

type Handler = (url: string, method: string) => Response | undefined;

// Serves GET /api/cart from a mutable list so removals/checkouts are reflected on reload.
function mockCartApi(initial: CartItem[], extra: Handler = () => undefined): { calls: [string, string][] } {
  let cart = [...initial];
  const calls: [string, string][] = [];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    calls.push([method, url]);
    const custom = extra(url, method);
    if (custom) return custom;
    if (url === '/api/cart' && method === 'GET') return jsonResponse(cart);
    const removeMatch = /^\/api\/cart\/(\d+)$/.exec(url);
    if (removeMatch && method === 'DELETE') {
      cart = cart.filter((c: CartItem) => c.miniId !== Number(removeMatch[1]));
      return jsonResponse({ message: 'Removed' });
    }
    return jsonResponse({ error: `unexpected ${method} ${url}` }, { ok: false });
  });
  return { calls };
}

function renderCart() {
  return render(
    <MemoryRouter>
      <CartPage />
    </MemoryRouter>
  );
}

describe('CartPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('shows an empty state with a link back to browsing', async () => {
    mockCartApi([]);
    renderCart();

    expect(await screen.findByText(/your cart is empty/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /browse/i })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: /check ?out/i })).not.toBeInTheDocument();
  });

  it('groups cart items by the owner you would be borrowing from', async () => {
    mockCartApi([
      item({ miniId: 1, name: 'Dire Wolf' }),
      item({ miniId: 2, name: 'Owlbear' }),
      item({ miniId: 3, name: 'Beholder', ownerId: 11, ownerName: 'Bob', ownerUsername: 'bob' }),
    ]);
    renderCart();

    const alice = await screen.findByRole('region', { name: /from alice/i });
    const bob = screen.getByRole('region', { name: /from bob/i });
    expect(within(alice).getByText('Dire Wolf')).toBeInTheDocument();
    expect(within(alice).getByText('Owlbear')).toBeInTheDocument();
    expect(within(bob).getByText('Beholder')).toBeInTheDocument();
    expect(within(bob).queryByText('Dire Wolf')).not.toBeInTheDocument();
  });

  it('explains that the cart does not hold anything until checkout', async () => {
    mockCartApi([item()]);
    renderCart();

    expect(await screen.findByText(/doesn't reserve/i)).toBeInTheDocument();
  });

  it('removes an item from the cart', async () => {
    const { calls } = mockCartApi([item({ miniId: 1, name: 'Dire Wolf' }), item({ miniId: 2, name: 'Owlbear' })]);
    renderCart();
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('button', { name: /remove dire wolf/i }));

    await waitFor(() => expect(screen.queryByText('Dire Wolf')).not.toBeInTheDocument());
    expect(screen.getByText('Owlbear')).toBeInTheDocument();
    expect(calls).toContainEqual(['DELETE', '/api/cart/1']);
  });

  it('flags items that were taken by someone else since you added them', async () => {
    mockCartApi([item({ name: 'Dire Wolf', status: 'requested' })]);
    renderCart();

    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
  });

  it('checks out, confirms how many requests were sent, and points to the loans page', async () => {
    let checkedOut = false;
    const { calls } = mockCartApi([item({ miniId: 1 }), item({ miniId: 2, name: 'Owlbear' })], (url: string, method: string) => {
      if (url === '/api/cart/checkout' && method === 'POST') {
        checkedOut = true;
        return jsonResponse({ created: [{ loanId: 5, miniId: 1 }, { loanId: 6, miniId: 2 }], unavailable: [] });
      }
      if (url === '/api/cart' && method === 'GET' && checkedOut) return jsonResponse([]);
      return undefined;
    });
    renderCart();
    await screen.findByText('Owlbear');

    await userEvent.click(screen.getByRole('button', { name: /check ?out/i }));

    expect(await screen.findByText(/sent 2 requests/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /loans/i })).toHaveAttribute('href', '/loans');
    expect(calls).toContainEqual(['POST', '/api/cart/checkout']);
    await waitFor(() => expect(screen.queryByText('Owlbear')).not.toBeInTheDocument());
  });

  it('on a partial checkout, names the minis that were no longer available', async () => {
    let checkedOut = false;
    mockCartApi([item({ miniId: 1 }), item({ miniId: 2, name: 'Owlbear' })], (url: string, method: string) => {
      if (url === '/api/cart/checkout' && method === 'POST') {
        checkedOut = true;
        return jsonResponse({ created: [{ loanId: 5, miniId: 1 }], unavailable: [{ miniId: 2, name: 'Owlbear' }] });
      }
      if (url === '/api/cart' && method === 'GET' && checkedOut) return jsonResponse([item({ miniId: 2, name: 'Owlbear', status: 'adventuring' })]);
      return undefined;
    });
    renderCart();
    await screen.findByText('Owlbear');

    await userEvent.click(screen.getByRole('button', { name: /check ?out/i }));

    expect(await screen.findByText(/sent 1 request\b/i)).toBeInTheDocument();
    expect(screen.getByText(/owlbear wasn't available/i)).toBeInTheDocument();
  });

  it('shows an error if the cart fails to load', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Select a collection first' }, { ok: false }));
    renderCart();

    expect(await screen.findByText(/select a collection first/i)).toBeInTheDocument();
  });

  it('shows an error and keeps the item if removing fails', async () => {
    mockCartApi([item({ name: 'Dire Wolf' })], (_url: string, method: string) =>
      method === 'DELETE' ? jsonResponse({ error: 'Server error' }, { ok: false }) : undefined);
    renderCart();
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('button', { name: /remove dire wolf/i }));

    expect(await screen.findByText('Server error')).toBeInTheDocument();
    expect(screen.getByText('Dire Wolf')).toBeInTheDocument();
  });

  it('shows each item\'s photo when it has one', async () => {
    mockCartApi([item({ image: '/uploads/wolf.png' })]);
    const { container } = renderCart();
    await screen.findByText('Dire Wolf');

    expect(container.querySelector('img')).toHaveAttribute('src', '/uploads/wolf.png');
  });

  it('disables checkout while it is in progress', async () => {
    let finish!: (r: Response) => void;
    mockCartApi([item()]);
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) =>
      urlOf(input) === '/api/cart/checkout' ? new Promise<Response>(resolve => { finish = resolve; }) : base(input, init));
    renderCart();
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('button', { name: /check ?out/i }));

    expect(screen.getByRole('button', { name: /checking out/i })).toBeDisabled();
    finish(jsonResponse({ created: [{ loanId: 1, miniId: 1 }], unavailable: [] }));
    expect(await screen.findByText(/sent 1 request\b/i)).toBeInTheDocument();
  });

  it('shows the server\'s error when nothing in the cart could be requested', async () => {
    mockCartApi([item({ status: 'adventuring' })], (url: string, method: string) => {
      if (url === '/api/cart/checkout' && method === 'POST') {
        return jsonResponse({ error: 'None of the minis in your cart are available right now', unavailable: [] }, { ok: false });
      }
      return undefined;
    });
    renderCart();
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('button', { name: /check ?out/i }));

    expect(await screen.findByText(/none of the minis in your cart are available/i)).toBeInTheDocument();
    expect(screen.queryByText(/sent \d+ request/i)).not.toBeInTheDocument();
  });
});
