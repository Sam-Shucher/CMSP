import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

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

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

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
      if (url === '/api/cart' || url === '/api/loans') return Promise.resolve(jsonResponse([]));
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

    expect(await screen.findByRole('button', { name: 'dojo' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'dojo' }));

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
