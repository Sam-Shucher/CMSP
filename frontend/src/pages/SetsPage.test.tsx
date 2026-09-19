import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SetsPage from './SetsPage';
import { AuthContext } from '../App';
import { Mini, MiniSet, CART_CHANGED_EVENT } from '../api/client';
import { jsonResponse, urlOf, jsonBodyOf } from '../test/apiMock';

const OWNER = { userId: 1, username: 'olivia', role: 'user' as const };
const OTHER = { userId: 2, username: 'bruno', role: 'user' as const };
const ADMIN = { userId: 3, username: 'ada', role: 'admin' as const };

function mini(overrides: Partial<Mini> = {}): Mini {
  return {
    id: 1, name: 'Banshee', description: null, images: [], price: 0,
    status: 'available', available: true,
    owner_name: 'Olivia Owner', owner_username: 'olivia', owner_id: OWNER.userId,
    tags: [], created_at: '2026-01-01T00:00:00.000Z', set_id: null, set_name: null,
    ...overrides,
  };
}

function set(overrides: Partial<MiniSet> = {}): MiniSet {
  return {
    id: 501, name: 'Blades of Khaine', ownerId: OWNER.userId, ownerName: 'Olivia Owner', ownerUsername: 'olivia',
    members: [mini({ id: 1, name: 'Banshee', set_id: 501, set_name: 'Blades of Khaine' })],
    ...overrides,
  };
}

type Handler = (url: string, method: string, body: unknown) => Response | undefined;

function mockApi(sets: MiniSet[], minis: Mini[] = [], extra: Handler = () => undefined) {
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    const custom = extra(url, method, jsonBodyOf(init));
    if (custom) return custom;
    if (url === '/api/sets' && method === 'GET') return jsonResponse(sets);
    if (url === '/api/minis' || url === '/api/minis?') return jsonResponse(minis);
    return jsonResponse({ error: `unexpected ${method} ${url}` }, { ok: false });
  });
}

function renderSets(user: { userId: number; username: string; role: string }) {
  return render(
    <AuthContext.Provider value={{ user, loading: false, setUser: vi.fn(), collections: [], selectCollection: vi.fn(), refreshSession: vi.fn() }}>
      <MemoryRouter><SetsPage /></MemoryRouter>
    </AuthContext.Provider>
  );
}

describe('SetsPage — listing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('lists a set with its members and their status', async () => {
    mockApi([set()]);
    renderSets(OTHER);

    expect(await screen.findByText('Blades of Khaine')).toBeInTheDocument();
    expect(screen.getByText('Banshee')).toBeInTheDocument();
    expect(screen.getByText('Olivia Owner', { exact: false })).toBeInTheDocument();
  });

  it('says plainly when there are no sets yet', async () => {
    mockApi([]);
    renderSets(OTHER);

    expect(await screen.findByText(/no sets yet/i)).toBeInTheDocument();
  });

  it('shows an empty set as having nothing in it', async () => {
    mockApi([set({ members: [] })]);
    renderSets(OTHER);

    expect(await screen.findByText(/nothing in this set yet/i)).toBeInTheDocument();
  });
});

describe('SetsPage — creating a set', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates a set with the name typed in, and no minis required', async () => {
    let created: unknown;
    mockApi([], [], (url, method, body) => {
      if (url === '/api/sets' && method === 'POST') { created = body; return jsonResponse({ id: 502, name: 'New Set', ownerId: OWNER.userId, ownerName: 'Olivia Owner', ownerUsername: 'olivia', members: [] }, { status: 201 }); }
      return undefined;
    });
    renderSets(OWNER);
    await screen.findByText(/no sets yet/i);

    await userEvent.type(screen.getByLabelText(/name/i), 'New Set');
    await userEvent.click(screen.getByRole('button', { name: /create set/i }));

    await waitFor(() => expect(created).toEqual({ name: 'New Set', miniIds: [] }));
  });

  it('offers your own ungrouped minis as checkboxes, and includes what you check', async () => {
    let created: unknown;
    mockApi([], [
      mini({ id: 10, name: 'Free Agent', owner_id: OWNER.userId, set_id: null }),
      mini({ id: 11, name: 'Already Grouped', owner_id: OWNER.userId, set_id: 999, set_name: 'Other Set' }),
      mini({ id: 12, name: "Someone Else's", owner_id: OTHER.userId }),
    ], (url, method, body) => {
      if (url === '/api/sets' && method === 'POST') { created = body; return jsonResponse({ id: 502, name: 'Squad', ownerId: OWNER.userId, ownerName: 'Olivia Owner', ownerUsername: 'olivia', members: [] }, { status: 201 }); }
      return undefined;
    });
    renderSets(OWNER);
    await screen.findByLabelText(/free agent/i);

    // Only YOUR ungrouped minis are offered.
    expect(screen.queryByLabelText(/already grouped/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/someone else's/i)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^name/i), 'Squad');
    await userEvent.click(screen.getByLabelText(/free agent/i));
    await userEvent.click(screen.getByRole('button', { name: /create set/i }));

    await waitFor(() => expect(created).toEqual({ name: 'Squad', miniIds: [10] }));
  });

  it('shows the server\'s error if creating fails', async () => {
    mockApi([], [], (url, method) => {
      if (url === '/api/sets' && method === 'POST') return jsonResponse({ error: 'Name is required' }, { ok: false, status: 400 });
      return undefined;
    });
    renderSets(OWNER);
    await screen.findByText(/no sets yet/i);

    await userEvent.type(screen.getByLabelText(/^name/i), 'x');
    await userEvent.click(screen.getByRole('button', { name: /create set/i }));

    expect(await screen.findByText('Name is required')).toBeInTheDocument();
  });
});

describe('SetsPage — borrowing a whole set', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('offers to borrow someone else\'s set, not your own', async () => {
    mockApi([set({ ownerId: OWNER.userId })]);
    renderSets(OWNER);
    await screen.findByText('Blades of Khaine');
    expect(screen.queryByRole('button', { name: /borrow this set/i })).not.toBeInTheDocument();

    mockApi([set({ ownerId: OWNER.userId })]);
    renderSets(OTHER);
    expect(await screen.findByRole('button', { name: /borrow this set/i })).toBeInTheDocument();
  });

  it('adds the set to your cart, and dispatches the cart-changed event', async () => {
    const heard = vi.fn();
    window.addEventListener(CART_CHANGED_EVENT, heard);
    mockApi([set()], [], (url, method) => {
      if (url === '/api/sets/501/cart' && method === 'POST') {
        return jsonResponse({ added: [{ miniId: 1, name: 'Banshee' }], skipped: [] }, { status: 201 });
      }
      return undefined;
    });
    renderSets(OTHER);
    await screen.findByText('Blades of Khaine');

    await userEvent.click(screen.getByRole('button', { name: /borrow this set/i }));

    expect(await screen.findByText(/added 1 mini to your cart/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /your cart/i })).toHaveAttribute('href', '/cart');
    expect(heard).toHaveBeenCalled();
    window.removeEventListener(CART_CHANGED_EVENT, heard);
  });

  it('says which members were skipped, and why', async () => {
    mockApi([set({ members: [mini({ id: 1, name: 'Banshee' }), mini({ id: 2, name: 'Farseer' })] })], [], (url, method) => {
      if (url === '/api/sets/501/cart' && method === 'POST') {
        return jsonResponse({
          added: [{ miniId: 1, name: 'Banshee' }],
          skipped: [{ miniId: 2, name: 'Farseer', reason: 'unavailable' }],
        }, { status: 201 });
      }
      return undefined;
    });
    renderSets(OTHER);
    await screen.findByText('Blades of Khaine');

    await userEvent.click(screen.getByRole('button', { name: /borrow this set/i }));

    expect(await screen.findByText(/farseer: not available right now/i)).toBeInTheDocument();
  });

  it('shows the server\'s refusal when nothing at all could be added', async () => {
    mockApi([set()], [], (url, method) => {
      if (url === '/api/sets/501/cart' && method === 'POST') {
        return jsonResponse({ error: 'That\'s your own set', added: [], skipped: [] }, { ok: false, status: 409 });
      }
      return undefined;
    });
    renderSets(OTHER);
    await screen.findByText('Blades of Khaine');

    await userEvent.click(screen.getByRole('button', { name: /borrow this set/i }));

    expect(await screen.findByText(/that's your own set/i)).toBeInTheDocument();
  });
});

describe('SetsPage — managing your own set', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renames a set you own', async () => {
    let patched: unknown;
    mockApi([set()], [], (url, method, body) => {
      if (url === '/api/sets/501' && method === 'PATCH') { patched = body; return jsonResponse({ ...set(), name: 'Renamed Host' }); }
      return undefined;
    });
    renderSets(OWNER);
    await screen.findByText('Blades of Khaine');

    const nameField = screen.getByLabelText(/rename/i);
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Renamed Host');
    await userEvent.click(screen.getByRole('button', { name: /save name/i }));

    await waitFor(() => expect(patched).toEqual({ name: 'Renamed Host' }));
  });

  it('removes a member from your set', async () => {
    let patched: unknown;
    mockApi([set()], [], (url, method, body) => {
      if (url === '/api/sets/501' && method === 'PATCH') { patched = body; return jsonResponse(set({ members: [] })); }
      return undefined;
    });
    renderSets(OWNER);
    await screen.findByText('Banshee');

    await userEvent.click(screen.getByRole('button', { name: /remove banshee/i }));

    await waitFor(() => expect(patched).toEqual({ removeMiniIds: [1] }));
  });

  it('adds one of your ungrouped minis to your set', async () => {
    let patched: unknown;
    mockApi([set()], [mini({ id: 20, name: 'Farseer', owner_id: OWNER.userId, set_id: null })], (url, method, body) => {
      if (url === '/api/sets/501' && method === 'PATCH') { patched = body; return jsonResponse(set()); }
      return undefined;
    });
    renderSets(OWNER);
    await screen.findByText('Blades of Khaine');

    await userEvent.selectOptions(screen.getByLabelText(/add a mini/i), '20');
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await waitFor(() => expect(patched).toEqual({ addMiniIds: [20] }));
  });

  it('deletes a set after confirming, and explains its minis are kept', async () => {
    let deleted = false;
    mockApi([set()], [], (url, method) => {
      if (url === '/api/sets/501' && method === 'DELETE') { deleted = true; return jsonResponse({ message: 'Set deleted' }); }
      return undefined;
    });
    renderSets(OWNER);
    await screen.findByText('Blades of Khaine');

    await userEvent.click(screen.getByRole('button', { name: /delete set/i }));
    expect(screen.getByText(/its minis stay/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /yes, delete/i }));

    await waitFor(() => expect(deleted).toBe(true));
  });

  it('does not show management controls to someone who isn\'t the owner or an admin', async () => {
    mockApi([set()]);
    renderSets(OTHER);
    await screen.findByText('Blades of Khaine');

    expect(screen.queryByLabelText(/rename/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete set/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove banshee/i })).not.toBeInTheDocument();
  });

  it('lets an admin rename or delete someone else\'s set', async () => {
    mockApi([set()]);
    renderSets(ADMIN);
    await screen.findByText('Blades of Khaine');

    expect(screen.getByLabelText(/rename/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete set/i })).toBeInTheDocument();
  });
});
