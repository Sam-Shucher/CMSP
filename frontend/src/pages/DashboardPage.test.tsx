import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage, { SEARCH_DEBOUNCE_MS } from './DashboardPage';
import { AuthContext } from '../App';
import { CartItem, Mini, MiniOwner, CART_CHANGED_EVENT } from '../api/client';
import { jsonResponse, urlOf, jsonBodyOf} from '../test/apiMock';

const MINI_OWNED_BY_1: Mini = {
  id: 1,
  name: 'Dire Wolf',
  description: 'A long, detailed description that only shows in the full detail view.',
  images: [],
  price: 0,
  status: 'available',
  available: true,
  owner_name: 'Owner Name',
  owner_username: 'owner',
  owner_id: 1,
  tags: [],
  created_at: '2026-01-01T00:00:00.000Z',
  set_id: null,
  set_name: null,
};

// Routes fetches by URL + method, so the order the page fires its requests in doesn't matter.
function mockApi({ minis = [MINI_OWNED_BY_1], cart = [] as CartItem[], onAddToCart }: {
  minis?: Mini[];
  cart?: CartItem[];
  onAddToCart?: (body: { miniId: number }) => { ok: boolean; body: unknown };
} = {}): void {
  let cartItems = [...cart];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/minis/tags')) return jsonResponse([]);
    if (url.startsWith('/api/minis/owners')) return jsonResponse([]);
    if (url.startsWith('/api/minis')) return jsonResponse(minis);
    if (url === '/api/cart' && method === 'GET') return jsonResponse(cartItems);
    if (url === '/api/cart' && method === 'POST') {
      const body = jsonBodyOf(init) as { miniId: number };
      const result = onAddToCart ? onAddToCart(body) : { ok: true, body: { ok: true } };
      if (result.ok) {
        const mini = minis.find((m: Mini) => m.id === body.miniId)!;
        cartItems = [...cartItems, {
          miniId: mini.id, name: mini.name, image: null, ownerId: mini.owner_id,
          ownerName: mini.owner_name, ownerUsername: mini.owner_username, status: mini.status,
        }];
      }
      return jsonResponse(result.body, { ok: result.ok });
    }
    return jsonResponse({ error: `unexpected ${method} ${url}` }, { ok: false });
  });
}

function renderDashboard(user: { userId: number; username: string; role: string }) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, loading: false, setUser: vi.fn(), collections: [], selectCollection: vi.fn(), refreshSession: vi.fn() }}>
        <DashboardPage />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('DashboardPage — edit access on mini cards', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    mockApi();
  });

  it('shows an Edit link to the mini\'s owner', async () => {
    renderDashboard({ userId: 1, username: 'owner', role: 'user' });

    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /edit/i })).toBeInTheDocument();
  });

  it('does not show an Edit link to a different, non-admin user', async () => {
    renderDashboard({ userId: 2, username: 'other', role: 'user' });

    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('shows an Edit link to an admin, even for someone else\'s mini', async () => {
    renderDashboard({ userId: 99, username: 'boss', role: 'admin' });

    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /edit/i })).toBeInTheDocument();
  });
});

describe('DashboardPage — mini detail overlay', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    mockApi();
  });

  it('opens the detail overlay when a card is clicked', async () => {
    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Dire Wolf'));
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('does not open the overlay when the Edit link is clicked', async () => {
    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('link', { name: /edit/i }));
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });

  it('does not show the description on the card itself — only after opening the overlay', async () => {
    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());
    expect(screen.queryByText(MINI_OWNED_BY_1.description!)).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Dire Wolf'));
    expect(screen.getByText(MINI_OWNED_BY_1.description!)).toBeInTheDocument();
  });
});

describe('DashboardPage — browsing, search, and tags', () => {
  function mockBrowse({ minis = [MINI_OWNED_BY_1], tags = ['boss', 'painted'], owners = [] as MiniOwner[], minisOk = true }: { minis?: Mini[]; tags?: string[]; owners?: MiniOwner[]; minisOk?: boolean } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith('/api/minis/tags')) return jsonResponse(tags);
      if (url.startsWith('/api/minis/owners')) return jsonResponse(owners);
      if (url.startsWith('/api/minis')) return minisOk ? jsonResponse(minis) : jsonResponse({ error: 'Server error' }, { ok: false });
      if (url === '/api/cart') return jsonResponse([]);
      return jsonResponse({}, { ok: false });
    }));
  }

  function minisUrls(): string[] {
    return vi.mocked(fetch).mock.calls.map(([u]) => urlOf(u)).filter(u => u.startsWith('/api/minis?'));
  }

  it('keeps a pasted search to the 100 characters the server accepts', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    expect(screen.getByPlaceholderText(/search/i)).toHaveAttribute('maxLength', '100');
  });

  it('searches as you type, sending the text to the server', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.type(screen.getByPlaceholderText(/search/i), 'wolf');

    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?q=wolf'));
  });

  it('filters by a tag pill, and clicking it again clears the filter', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('button', { name: 'boss' }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?tag=boss'));

    await userEvent.click(screen.getByRole('button', { name: 'boss' }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?'));
  });

  it('sorts by name or price, and back to newest sends no sort param', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), 'name');
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?sort=name'));

    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), 'price');
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?sort=price'));

    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), 'newest');
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?'));
  });

  it('lists each owner\'s name as an option, plus "All owners"', async () => {
    mockBrowse({ owners: [{ id: 7, name: 'Someone Else' }, { id: 9, name: 'Third Person' }] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    const ownerSelect = screen.getByLabelText(/owner/i);
    expect(within(ownerSelect).getByRole('option', { name: 'All owners' })).toBeInTheDocument();
    expect(within(ownerSelect).getByRole('option', { name: 'Someone Else' })).toBeInTheDocument();
    expect(within(ownerSelect).getByRole('option', { name: 'Third Person' })).toBeInTheDocument();
  });

  it('filters by owner from the dropdown, and back to "All owners" clears it', async () => {
    mockBrowse({ owners: [{ id: 7, name: 'Someone Else' }] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.selectOptions(screen.getByLabelText(/owner/i), '7');
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?owner=7'));

    await userEvent.selectOptions(screen.getByLabelText(/owner/i), 'All owners');
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?'));
  });

  it('checking "Available only" filters, unchecking clears it', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('checkbox', { name: /available only/i }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?available=1'));

    await userEvent.click(screen.getByRole('checkbox', { name: /available only/i }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?'));
  });

  it('checking "Only my minis" filters to your own owner id, unchecking clears it', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('checkbox', { name: /only my minis/i }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?owner=2'));

    await userEvent.click(screen.getByRole('checkbox', { name: /only my minis/i }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?'));
  });

  it('picking a different owner from the dropdown un-checks "Only my minis"', async () => {
    mockBrowse({ owners: [{ id: 7, name: 'Someone Else' }] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('checkbox', { name: /only my minis/i }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?owner=2'));

    await userEvent.selectOptions(screen.getByLabelText(/^owner$/i), '7');
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?owner=7'));
    expect(screen.getByRole('checkbox', { name: /only my minis/i })).not.toBeChecked();
  });

  it('picking your own name from the owner dropdown checks "Only my minis" too — same underlying filter', async () => {
    mockBrowse({ owners: [{ id: 2, name: 'Own Display Name' }] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.selectOptions(screen.getByLabelText(/^owner$/i), '2');

    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?owner=2'));
    expect(screen.getByRole('checkbox', { name: /only my minis/i })).toBeChecked();
  });

  it('combines search, tag, owner, sort, and available-only in one request', async () => {
    mockBrowse({ owners: [{ id: 7, name: 'Someone Else' }] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.type(screen.getByPlaceholderText(/search/i), 'wolf');
    await userEvent.click(screen.getByRole('button', { name: 'boss' }));
    await userEvent.selectOptions(screen.getByLabelText(/owner/i), '7');
    await userEvent.selectOptions(screen.getByLabelText(/sort by/i), 'price');
    await userEvent.click(screen.getByRole('checkbox', { name: /available only/i }));

    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?q=wolf&tag=boss&owner=7&sort=price&available=1'));
  });

  it('"All" clears the tag filter', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('button', { name: 'painted' }));
    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?tag=painted'));
    await userEvent.click(screen.getByRole('button', { name: 'All' }));

    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?'));
  });

  it('hides the tag bar when there are no tags', async () => {
    mockBrowse({ tags: [] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    expect(screen.queryByRole('button', { name: 'All' })).not.toBeInTheDocument();
  });

  it('invites adding the first mini when the collection is empty', async () => {
    mockBrowse({ minis: [], tags: [] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });

    expect(await screen.findByText(/no minis found/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /add the first one/i })).toHaveAttribute('href', '/upload');
  });

  it('suggests a different search when a search finds nothing', async () => {
    mockBrowse({ minis: [] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText(/no minis found/i);

    await userEvent.type(screen.getByPlaceholderText(/search/i), 'zzz');

    expect(await screen.findByText(/try a different search or tag/i)).toBeInTheDocument();
  });

  it('shows an error when the minis fail to load', async () => {
    mockBrowse({ minisOk: false });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });

    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });

  // A first load that fails used to show the error AND "No minis found · Add
  // the first one!" — telling someone with no signal that their collection is
  // empty, and inviting them to refill it.
  it('does not claim the collection is empty when loading it failed', async () => {
    mockBrowse({ minisOk: false });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Server error');

    expect(screen.queryByText(/no minis found/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /add the first one/i })).not.toBeInTheDocument();
  });

  // One request per keystroke meant 24 for a typed search phrase, each one
  // reading the whole collection and fuzzy-matching it on the Pi's one core.
  it('waits for a pause in typing before searching', async () => {
    vi.useFakeTimers();
    try {
      mockBrowse();
      renderDashboard({ userId: 2, username: 'other', role: 'user' });
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS + 50);
      const before = minisUrls().length;

      const box = screen.getByPlaceholderText(/search/i);
      let typed = '';
      for (const char of 'owlbear') {
        typed += char;
        fireEvent.change(box, { target: { value: typed } });
        await vi.advanceTimersByTimeAsync(60); // a fast typist, ~16 chars/sec
      }

      // Still nothing sent while the keys are still coming.
      expect(minisUrls().length).toBe(before);

      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);

      expect(minisUrls().length).toBe(before + 1);
      expect(minisUrls().at(-1)).toBe('/api/minis?q=owlbear');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not make you wait for the pause when picking a tag', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    await userEvent.click(screen.getByRole('button', { name: 'boss' }));

    await waitFor(() => expect(minisUrls().at(-1)).toBe('/api/minis?tag=boss'));
  });

  it('shows the cover photo, a count of extra photos, the price, and tags on the card', async () => {
    mockBrowse({
      minis: [{ ...MINI_OWNED_BY_1, images: ['/uploads/a.png', '/uploads/b.png', '/uploads/c.png'], price: 12.5, tags: ['boss'] }],
    });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });

    const cover = await screen.findByRole('img', { name: 'Dire Wolf' });
    expect(cover).toHaveAttribute('src', '/uploads/a.png');
    expect(screen.getByText('+2')).toBeInTheDocument();
    expect(screen.getByText('$12.50')).toBeInTheDocument();
    expect(screen.getByText('boss', { selector: '.tag' })).toBeInTheDocument();
  });

  it('shows no price for a free mini', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it('shows which set a mini is part of, and nothing when it isn\'t in one', async () => {
    mockBrowse({ minis: [{ ...MINI_OWNED_BY_1, set_id: 501, set_name: 'Blades of Khaine' }] });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });

    expect(await screen.findByText(/part of: blades of khaine/i)).toBeInTheDocument();
  });

  it('shows no set line for a mini that is not in one', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await screen.findByText('Dire Wolf');

    expect(screen.queryByText(/part of:/i)).not.toBeInTheDocument();
  });

  it('closes the overlay', async () => {
    mockBrowse();
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await userEvent.click(await screen.findByText('Dire Wolf'));

    await userEvent.click(screen.getByRole('button', { name: /close/i }));

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
});

describe('DashboardPage — taking your own mini on a quest', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('takes it out from the detail view and updates the card right away', async () => {
    const questing = { ...MINI_OWNED_BY_1, status: 'on_quest' as const, available: false, on_quest_since: '2026-10-01T18:00:00.000Z', on_quest_until: null };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === '/api/minis/1/take-out' && init?.method === 'POST') return jsonResponse(questing);
      if (url.startsWith('/api/minis/tags')) return jsonResponse([]);
      if (url.startsWith('/api/minis/owners')) return jsonResponse([]);
      if (url.startsWith('/api/minis')) return jsonResponse([MINI_OWNED_BY_1]);
      if (url === '/api/cart') return jsonResponse([]);
      return jsonResponse({ error: 'unexpected' }, { ok: false });
    });
    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await userEvent.click(await screen.findByText('Dire Wolf'));

    await userEvent.click(screen.getByRole('button', { name: /take on a quest/i }));

    expect(fetch).toHaveBeenCalledWith('/api/minis/1/take-out', expect.objectContaining({ method: 'POST', body: JSON.stringify({ backBy: null }) }));
    expect(await screen.findByRole('button', { name: /bring it back/i })).toBeInTheDocument();
    expect(screen.getAllByText('On a Quest').length).toBeGreaterThanOrEqual(2); // card and detail view
  });

  it('brings it back', async () => {
    const questing = { ...MINI_OWNED_BY_1, status: 'on_quest' as const, available: false, on_quest_since: '2026-10-01T18:00:00.000Z', on_quest_until: '2026-10-15' };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url === '/api/minis/1/bring-back' && init?.method === 'POST') return jsonResponse(MINI_OWNED_BY_1);
      if (url.startsWith('/api/minis/tags')) return jsonResponse([]);
      if (url.startsWith('/api/minis/owners')) return jsonResponse([]);
      if (url.startsWith('/api/minis')) return jsonResponse([questing]);
      if (url === '/api/cart') return jsonResponse([]);
      return jsonResponse({ error: 'unexpected' }, { ok: false });
    });
    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await userEvent.click(await screen.findByText('Dire Wolf'));

    await userEvent.click(screen.getByRole('button', { name: /bring it back/i }));

    expect(await screen.findByRole('button', { name: /take on a quest/i })).toBeInTheDocument();
    expect(screen.getAllByText('Available').length).toBeGreaterThanOrEqual(2);
  });
});

describe('DashboardPage — status badges and the cart', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('labels each card Available, Requested, or Adventuring', async () => {
    mockApi({
      minis: [
        MINI_OWNED_BY_1,
        { ...MINI_OWNED_BY_1, id: 2, name: 'Owlbear', status: 'requested', available: false },
        { ...MINI_OWNED_BY_1, id: 3, name: 'Beholder', status: 'adventuring', available: false },
      ],
    });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });

    await waitFor(() => expect(screen.getByText('Beholder')).toBeInTheDocument());
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(screen.getByText('Adventuring')).toBeInTheDocument();
  });

  it('adds someone else\'s available mini to the cart from the overlay', async () => {
    const onAddToCart = vi.fn(() => ({ ok: true, body: { ok: true } }));
    mockApi({ onAddToCart });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Dire Wolf'));
    await userEvent.click(screen.getByRole('button', { name: /add to cart/i }));

    expect(onAddToCart).toHaveBeenCalledWith({ miniId: 1 });
    expect(await screen.findByRole('button', { name: /in your cart/i })).toBeDisabled();
  });

  it('shows minis already in the cart as in your cart', async () => {
    mockApi({
      cart: [{ miniId: 1, name: 'Dire Wolf', image: null, ownerId: 1, ownerName: 'Owner Name', ownerUsername: 'owner', status: 'available' }],
    });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Dire Wolf'));
    expect(await screen.findByRole('button', { name: /in your cart/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
  });

  it('does not offer the cart on your own mini', async () => {
    mockApi();
    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Dire Wolf'));
    expect(screen.getByText(/this is your mini/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add to cart/i })).not.toBeInTheDocument();
  });

  // The nav's Cart count listens for this, so it updates on the click rather
  // than up to a minute later.
  it('announces that the cart changed so the nav count keeps up', async () => {
    mockApi({ onAddToCart: () => ({ ok: true, body: { ok: true } }) });
    const heard = vi.fn();
    window.addEventListener(CART_CHANGED_EVENT, heard);
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Dire Wolf'));
    await userEvent.click(screen.getByRole('button', { name: /add to cart/i }));

    await waitFor(() => expect(heard).toHaveBeenCalled());
    window.removeEventListener(CART_CHANGED_EVENT, heard);
  });

  it('doesn\'t announce a cart change when adding failed', async () => {
    mockApi({ onAddToCart: () => ({ ok: false, body: { error: 'Nope' } }) });
    const heard = vi.fn();
    window.addEventListener(CART_CHANGED_EVENT, heard);
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Dire Wolf'));
    await userEvent.click(screen.getByRole('button', { name: /add to cart/i }));

    await screen.findByText(/nope/i);
    expect(heard).not.toHaveBeenCalled();
    window.removeEventListener(CART_CHANGED_EVENT, heard);
  });

  it('shows the server\'s refusal if the mini was taken in the meantime', async () => {
    mockApi({ onAddToCart: () => ({ ok: false, body: { error: "That mini isn't available right now" } }) });
    renderDashboard({ userId: 2, username: 'other', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByText('Dire Wolf'));
    await userEvent.click(screen.getByRole('button', { name: /add to cart/i }));

    expect(await screen.findByText(/isn't available right now/i)).toBeInTheDocument();
  });
});
