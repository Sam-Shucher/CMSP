import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import { resyncPush, forgetPushOnSignOut, listenForPushes } from './push';
import { jsonResponse } from './test/apiMock';

// push.test.ts checks each phone-notification helper on its own; this checks
// App actually calls them at the right moments. The server forgets a device on
// sign-out, so if these weren't wired up a signed-out phone would keep showing
// someone's notices, or a signed-in one would silently stop getting them.
vi.mock('./push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./push')>()),
  resyncPush: vi.fn(async () => {}),
  forgetPushOnSignOut: vi.fn(async () => {}),
  listenForPushes: vi.fn(() => () => {}),
}));

const USER = { userId: 1, username: 'owner', role: 'user', collectionId: 5 };

function mockServer(loggedIn: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!loggedIn) return jsonResponse({ error: 'Authentication required' }, { ok: false, status: 401 });
    if (url === '/api/auth/me') return jsonResponse(USER);
    if (url === '/api/auth/collections') return jsonResponse([{ id: 5, name: 'Chicago' }]);
    if (url === '/api/auth/logout') return jsonResponse({ message: 'Logged out' });
    if (url === '/api/notifications') return jsonResponse({ unread: 0, items: [] });
    if (url.startsWith('/api/minis') || url === '/api/cart' || url === '/api/loans') return jsonResponse([]);
    return jsonResponse({});
  }));
}

beforeEach(() => {
  window.history.pushState({}, '', '/');
  vi.mocked(resyncPush).mockClear();
  vi.mocked(forgetPushOnSignOut).mockClear();
  vi.mocked(listenForPushes).mockClear();
});

describe('App — phone notifications', () => {
  it('signs this device up for whoever the restored session belongs to', async () => {
    mockServer(true);
    render(<App />);

    await screen.findByRole('button', { name: /logout/i });
    await waitFor(() => expect(resyncPush).toHaveBeenCalledTimes(1));
  });

  it('signs nobody up when nobody is signed in', async () => {
    mockServer(false);
    render(<App />);

    await screen.findByRole('button', { name: /sign in/i });
    expect(resyncPush).not.toHaveBeenCalled();
  });

  it('listens for pushes while the site is open, signed in or not', async () => {
    mockServer(false);
    render(<App />);

    await screen.findByRole('button', { name: /sign in/i });
    expect(listenForPushes).toHaveBeenCalled();
  });

  // Order matters: the server can only tell whose device this is while the
  // session still exists.
  it('lets the server forget this device before the session ends on sign-out', async () => {
    mockServer(true);
    render(<App />);

    await userEvent.click(await screen.findByRole('button', { name: /logout/i }));
    await screen.findByRole('button', { name: /sign in/i });

    expect(forgetPushOnSignOut).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(fetch).mock.calls;
    const logoutIndex = calls.findIndex(([url]) => url === '/api/auth/logout');
    expect(logoutIndex).toBeGreaterThan(-1);
    expect(vi.mocked(forgetPushOnSignOut).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[logoutIndex]);
  });
});
