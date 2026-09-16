import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import DashboardPage from './DashboardPage';
import { AuthContext } from '../App';

const MINI_OWNED_BY_1 = {
  id: 1,
  name: 'Dire Wolf',
  description: 'A long, detailed description that only shows in the full detail view.',
  images: [],
  price: 0,
  available: true,
  owner_name: 'Owner Name',
  owner_username: 'owner',
  owner_id: 1,
  tags: [],
  created_at: '2026-01-01T00:00:00.000Z',
};

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
  });

  it('shows an Edit link to the mini\'s owner', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => [MINI_OWNED_BY_1] } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response); // tags

    renderDashboard({ userId: 1, username: 'owner', role: 'user' });

    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /edit/i })).toBeInTheDocument();
  });

  it('does not show an Edit link to a different, non-admin user', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => [MINI_OWNED_BY_1] } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);

    renderDashboard({ userId: 2, username: 'other', role: 'user' });

    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /edit/i })).not.toBeInTheDocument();
  });

  it('shows an Edit link to an admin, even for someone else\'s mini', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => [MINI_OWNED_BY_1] } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);

    renderDashboard({ userId: 99, username: 'boss', role: 'admin' });

    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /edit/i })).toBeInTheDocument();
  });
});

describe('DashboardPage — mini detail overlay', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('opens the detail overlay when a card is clicked', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => [MINI_OWNED_BY_1] } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);

    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('Dire Wolf'));
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
  });

  it('does not open the overlay when the Edit link is clicked', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => [MINI_OWNED_BY_1] } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);

    renderDashboard({ userId: 1, username: 'owner', role: 'user' });
    await waitFor(() => expect(screen.getByText('Dire Wolf')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('link', { name: /edit/i }));
    expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
  });
});
