import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage';
import { AuthContext } from '../App';

const SELF_ADMIN = { userId: 1, username: 'boss', role: 'admin' };

const EMAILS = [
  { id: 10, email: 'friend@example.com', added_at: '2026-01-01T00:00:00.000Z', added_by_username: 'boss' },
];

const USERS = [
  { id: 1, email: 'boss@example.com', username: 'boss', display_name: 'Boss', phone: null, neighborhood: null, role: 'admin', created_at: '2026-01-01T00:00:00.000Z' },
  { id: 2, email: 'grunt@example.com', username: 'grunt', display_name: 'Grunt', phone: null, neighborhood: null, role: 'user', created_at: '2026-01-01T00:00:00.000Z' },
];

function renderAdminPage() {
  return render(
    <AuthContext.Provider value={{ user: SELF_ADMIN, loading: false, setUser: vi.fn(), collections: [], selectCollection: vi.fn(), refreshSession: vi.fn() }}>
      <AdminPage />
    </AuthContext.Provider>
  );
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

describe('AdminPage — type-to-confirm deletion', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/admin/approved-emails') return Promise.resolve(jsonResponse(EMAILS));
      if (url === '/api/admin/users')            return Promise.resolve(jsonResponse(USERS));
      return Promise.resolve(jsonResponse({ message: 'ok' }));
    }));
  });

  it('does not call the API until the exact email is retyped in the confirm modal', async () => {
    renderAdminPage();
    await screen.findByText('friend@example.com');

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    const deleteButton = await screen.findByRole('button', { name: /^delete$/i });
    expect(deleteButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type/i), 'wrong@example.com');
    expect(deleteButton).toBeDisabled();
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/approved-emails/10', expect.anything());
  });

  it('removes the email once the exact email is retyped and Delete is clicked', async () => {
    renderAdminPage();
    await screen.findByText('friend@example.com');

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'friend@example.com');
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/admin/approved-emails/10', expect.objectContaining({ method: 'DELETE' }))
    );
  });

  it('does not show a Remove from Group button for your own row', async () => {
    renderAdminPage();
    await screen.findByText('grunt');

    const rows = screen.getAllByRole('row');
    const bossRow = rows.find(r => r.textContent?.includes('boss'));
    expect(bossRow).toBeDefined();
    expect(within(bossRow!).queryByRole('button', { name: /remove from group/i })).not.toBeInTheDocument();
  });

  it('removes another user from the group once their username is retyped and confirmed', async () => {
    renderAdminPage();
    await screen.findByText('grunt');

    const rows = screen.getAllByRole('row');
    const gruntRow = rows.find(r => r.textContent?.includes('grunt'));
    await userEvent.click(within(gruntRow!).getByRole('button', { name: /remove from group/i }));

    await userEvent.type(await screen.findByLabelText(/type/i), 'grunt');
    await userEvent.click(screen.getByRole('button', { name: /^confirm delete$/i }));

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/admin/users/2', expect.objectContaining({ method: 'DELETE' }))
    );
  });
});
