import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

const USER = { userId: 1, username: 'owner', role: 'user' };
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

describe('App nav — username link', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/auth/me')  return Promise.resolve(jsonResponse(USER));
      if (url === '/api/users/me') return Promise.resolve(jsonResponse(PROFILE));
      if (url.startsWith('/api/minis/tags')) return Promise.resolve(jsonResponse([]));
      if (url.startsWith('/api/minis'))       return Promise.resolve(jsonResponse([]));
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
});
