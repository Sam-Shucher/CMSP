import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { jsonResponse, jsonBodyOf} from './test/apiMock';

const USER = { userId: 1, username: 'owner', role: 'user', collectionId: 5 };
const MY_COLLECTIONS = [{ id: 5, name: 'Chicago' }];
const PROFILE = {
  id: 1,
  email: 'owner@example.com',
  username: 'owner',
  display_name: 'Owner Name',
  phone: null,
  neighborhood: null,
  role: 'user',
};

// App uses a real BrowserRouter, which reads actual window.location — reset
// it before each test so navigation from an earlier test doesn't leak in.
beforeEach(() => {
  window.history.pushState({}, '', '/');
});

describe('App nav — username link', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me')          return Promise.resolve(jsonResponse(USER));
      if (url === '/api/auth/collections') return Promise.resolve(jsonResponse(MY_COLLECTIONS));
      if (url === '/api/users/me') return Promise.resolve(jsonResponse(PROFILE));
      if (url.startsWith('/api/minis/tags')) return Promise.resolve(jsonResponse([]));
      if (url.startsWith('/api/minis'))       return Promise.resolve(jsonResponse([]));
      if (url === '/api/cart' || url === '/api/loans' || url === '/api/sets') return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    }));
  });

  it('renders the username as a link to the profile page and navigates there on click', async () => {
    render(<App />);

    const usernameLink = await screen.findByRole('link', { name: 'owner' });
    expect(usernameLink).toHaveAttribute('href', '/profile');

    await userEvent.click(usernameLink);

    await waitFor(() => expect(screen.getByText(/my profile/i)).toBeInTheDocument());
  });

  it('links to the cart page from the nav', async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole('link', { name: 'Cart' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: /your cart/i })).toBeInTheDocument());
  });

  it('links to the loans page from the nav', async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole('link', { name: 'Loans' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: /^loans$/i })).toBeInTheDocument());
  });

  it('links to the sets page from the nav', async () => {
    render(<App />);

    await userEvent.click(await screen.findByRole('link', { name: 'Sets' }));

    await waitFor(() => expect(screen.getByRole('heading', { name: /^sets$/i })).toBeInTheDocument());
  });
});

// A route serves either a fixed JSON body or a function of the request.
type Route = ((init?: RequestInit) => Response) | Record<string, unknown> | unknown[];
type Routes = Record<string, Route>;

// Serves the given URL → body map; anything unlisted gets a 401, like a logged-out server.
function mockServer(routes: Routes) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find(k => url === k || (k.endsWith('*') && url.startsWith(k.slice(0, -1))));
    if (!key) return jsonResponse({ error: 'Authentication required' }, { ok: false, status: 401, statusText: 'Unauthorized' });
    const value = routes[key];
    return typeof value === 'function' ? value(init) : jsonResponse(value);
  }));
}

const LOGGED_IN_ROUTES: Routes = {
  '/api/auth/me': USER,
  '/api/auth/collections': MY_COLLECTIONS,
  '/api/minis*': [],
  '/api/cart': [],
  '/api/loans': [],
  '/api/users/me': PROFILE,
  '/api/auth/logout': { message: 'Logged out' },
  '/api/notifications': { unread: 2, items: [] },
  '/api/holds': { holds: [], watching: [] },
  '/api/bookings': { mine: [], onMyMinis: [] },
};

describe('App — logged out', () => {
  it.each(['/', '/cart', '/loans', '/upload', '/profile', '/admin'])('sends a logged-out visitor from %s to the login page', async (path) => {
    window.history.pushState({}, '', path);
    mockServer({});

    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/login');
  });

  it('shows no nav bar on the login page', async () => {
    window.history.pushState({}, '', '/login');
    mockServer({});

    render(<App />);

    await screen.findByRole('button', { name: /sign in/i });
    expect(screen.queryByRole('link', { name: 'Cart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /logout/i })).not.toBeInTheDocument();
  });

  it('sends an unknown URL to the dashboard (and so to login when logged out)', async () => {
    window.history.pushState({}, '', '/no/such/page');
    mockServer({});

    render(<App />);

    await screen.findByRole('button', { name: /sign in/i });
    expect(window.location.pathname).toBe('/login');
  });
});

describe('App — nav bar', () => {
  it('logs out: tells the server, clears the session, and returns to login', async () => {
    mockServer(LOGGED_IN_ROUTES);
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: /logout/i }));

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
    expect(screen.queryByRole('link', { name: 'owner' })).not.toBeInTheDocument();
  });

  it('shows the notification bell with the unread count', async () => {
    mockServer(LOGGED_IN_ROUTES);
    render(<App />);

    expect(await screen.findByRole('button', { name: /notifications \(2 unread\)/i })).toBeInTheDocument();
  });

  it('shows the Admin link only to admins', async () => {
    mockServer(LOGGED_IN_ROUTES);
    const { unmount } = render(<App />);
    await screen.findByRole('link', { name: 'owner' });
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    unmount();

    mockServer({ ...LOGGED_IN_ROUTES, '/api/auth/me': { ...USER, role: 'admin' } });
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin');
  });

  it('shows the active group\'s name with no switch option when you belong to only one', async () => {
    mockServer(LOGGED_IN_ROUTES);
    render(<App />);

    expect(await screen.findByText('Chicago')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch/i })).not.toBeInTheDocument();
  });

  it('lets someone in several groups switch, going back through the group picker', async () => {
    const collections = [{ id: 5, name: 'Chicago' }, { id: 6, name: 'dojo' }];
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/collections': collections,
      '/api/auth/select-collection': (init?: RequestInit) => jsonResponse({ ...USER, ...(jsonBodyOf(init) as object) }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: /chicago \(switch\)/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^dojo/i }));

    expect(await screen.findByRole('button', { name: /dojo \(switch\)/i })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/auth/select-collection', expect.objectContaining({
      body: JSON.stringify({ collectionId: 6 }),
    }));
  });
});

describe('App — your role depends on the group you enter', () => {
  const collections = [{ id: 5, name: 'Chicago', role: 'admin' }, { id: 6, name: 'dojo', role: 'user' }];
  const selectReturnsRole = (init?: RequestInit) => {
    const { collectionId } = jsonBodyOf(init) as { collectionId: number };
    const picked = collections.find(c => c.id === collectionId)!;
    return jsonResponse({ userId: 1, username: 'owner', collectionId, collectionName: picked.name, role: picked.role });
  };

  it('shows the admin view after entering a group where you are an admin', async () => {
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/me': { userId: 1, username: 'owner', role: 'user' },
      '/api/auth/collections': collections,
      '/api/auth/select-collection': selectReturnsRole,
    });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: /^chicago/i }));

    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();
  });

  it('shows the member view after entering a group where you are a member', async () => {
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/me': { userId: 1, username: 'owner', role: 'user' },
      '/api/auth/collections': collections,
      '/api/auth/select-collection': selectReturnsRole,
    });
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: /^dojo/i }));

    expect(await screen.findByRole('button', { name: /dojo \(switch\)/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('drops admin controls when switching from an admin group to a member group', async () => {
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/me': { userId: 1, username: 'owner', role: 'admin', collectionId: 5 },
      '/api/auth/collections': collections,
      '/api/auth/select-collection': selectReturnsRole,
    });
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Admin' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /chicago \(switch\)/i }));
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument(); // not while choosing, either
    await userEvent.click(await screen.findByRole('button', { name: /^dojo/i }));

    await screen.findByRole('button', { name: /dojo \(switch\)/i });
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });
});

describe('App — switching groups in another tab', () => {
  it('catches up and says so, when this tab was still showing the old group', async () => {
    const collections = [{ id: 5, name: 'Chicago' }, { id: 6, name: 'dojo' }];
    let otherTabSwitched = false;
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/collections': collections,
      '/api/auth/me': () => jsonResponse(otherTabSwitched ? { ...USER, collectionId: 6 } : USER),
      '/api/loans': (init?: RequestInit) => {
        const pageGroup = (init?.headers as Record<string, string> | undefined)?.['X-Collection-Id'];
        return otherTabSwitched && pageGroup === '5'
          ? ({ ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'You switched groups in another tab — this page has been updated to match. Please try again.', code: 'group_changed' }) } as Response)
          : jsonResponse([]);
      },
    });
    render(<App />);
    await screen.findByRole('button', { name: /chicago \(switch\)/i });

    otherTabSwitched = true;
    await userEvent.click(screen.getByRole('link', { name: 'Loans' }));

    expect(await screen.findByRole('button', { name: /dojo \(switch\)/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('You switched to dojo in another tab, so this tab switched too.');
  });
});

describe('App — after an admin hands out a temporary password', () => {
  it('insists on a new password before anything else, then lets them in', async () => {
    let changed = false;
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/me': () => jsonResponse({ ...USER, mustChangePassword: !changed }),
      '/api/users/me/password': () => { changed = true; return jsonResponse({ message: 'Password changed' }); },
    });
    render(<App />);

    // No app, no nav — just the change-password screen.
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.getByText(/temporary password/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Browse' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Current password'), 'the-temporary-one');
    await userEvent.type(screen.getByLabelText('New password'), 'a brand new password 2');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'a brand new password 2');
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('link', { name: 'Browse' })).toBeInTheDocument();
  });

  it('leaves everyone else alone', async () => {
    mockServer(LOGGED_IN_ROUTES);
    render(<App />);

    expect(await screen.findByRole('link', { name: 'Browse' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Choose a new password' })).not.toBeInTheDocument();
  });
});

describe('App — when a session ends', () => {
  it('sends you back to sign in with an explanation when the server says your session is over', async () => {
    let sessionAlive = true;
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/loans': () => sessionAlive
        ? jsonResponse([])
        : ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: 'Your session has ended. Please sign in again.' }) } as Response),
    });
    render(<App />);
    await screen.findByRole('link', { name: 'owner' });

    sessionAlive = false; // e.g. "log out everywhere" was used on another device
    await userEvent.click(screen.getByRole('link', { name: 'Loans' }));

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByText(/your session has ended/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'owner' })).not.toBeInTheDocument();
  });

  it('does not show that message to someone who simply isn\'t logged in', async () => {
    window.history.pushState({}, '', '/login');
    mockServer({});

    render(<App />);

    await screen.findByRole('button', { name: /sign in/i });
    expect(screen.queryByText(/your session has ended/i)).not.toBeInTheDocument();
  });
});

describe('App — admin page access', () => {
  it('redirects a non-admin away from /admin to the dashboard', async () => {
    window.history.pushState({}, '', '/admin');
    mockServer(LOGGED_IN_ROUTES);

    render(<App />);

    expect(await screen.findByText(/the collection/i)).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/users', expect.anything());
  });

  it('lets an admin open /admin', async () => {
    window.history.pushState({}, '', '/admin');
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/me': { ...USER, role: 'admin' },
      '/api/admin/approved-emails': [],
      '/api/admin/users': [],
      '/api/admin/archived-minis': [],
      '/api/admin/audit-log': [],
      '/api/admin/loan-incidents': [],
    });

    render(<App />);

    expect(await screen.findByText(/admin panel/i)).toBeInTheDocument();
  });
});

describe('App — restoring the session', () => {
  it('automatically enters the only group a user belongs to when none is selected yet', async () => {
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/me': { userId: 1, username: 'owner', role: 'user' },
      '/api/auth/select-collection': { ...USER, collectionId: 5 },
    });

    render(<App />);

    expect(await screen.findByText(/the collection/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/auth/select-collection', expect.objectContaining({
      body: JSON.stringify({ collectionId: 5 }),
    }));
  });

  it('still logs in if the group list fails to load (just without a group name)', async () => {
    mockServer({
      ...LOGGED_IN_ROUTES,
      '/api/auth/collections': () => ({ ok: false, statusText: 'Error', json: async () => ({ error: 'Server error' }) } as Response),
    });

    render(<App />);

    expect(await screen.findByRole('link', { name: 'owner' })).toBeInTheDocument();
    expect(screen.queryByText('Chicago')).not.toBeInTheDocument();
  });
});

describe('App — group selection gate', () => {
  it('shows a picker and enters the dashboard once a group is chosen, when the user belongs to more than one', async () => {
    const userNoGroup = { userId: 1, username: 'owner', role: 'user' }; // no collectionId yet
    const collections = [{ id: 5, name: 'Chicago' }, { id: 6, name: 'dojo' }];

    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/auth/me')          return Promise.resolve(jsonResponse(userNoGroup));
      if (url === '/api/auth/collections') return Promise.resolve(jsonResponse(collections));
      if (url === '/api/auth/select-collection') {
        const body = JSON.parse((options?.body as string) ?? '{}');
        return Promise.resolve(jsonResponse({ ...userNoGroup, collectionId: body.collectionId }));
      }
      if (url.startsWith('/api/minis/tags')) return Promise.resolve(jsonResponse([]));
      if (url.startsWith('/api/minis'))       return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    }));

    render(<App />);

    expect(await screen.findByRole('button', { name: /^dojo/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^dojo/i }));

    await waitFor(() => expect(screen.getByText(/The Collection/i)).toBeInTheDocument());
    expect(screen.getByText(/dojo \(switch\)/i)).toBeInTheDocument();
  });

  it('shows a message instead of a broken dashboard when the user belongs to no groups', async () => {
    const userNoGroup = { userId: 1, username: 'owner', role: 'user' };

    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me')          return Promise.resolve(jsonResponse(userNoGroup));
      if (url === '/api/auth/collections') return Promise.resolve(jsonResponse([]));
      return Promise.resolve(jsonResponse({}));
    }));

    render(<App />);

    expect(await screen.findByText(/not in any group yet/i)).toBeInTheDocument();
  });
});
