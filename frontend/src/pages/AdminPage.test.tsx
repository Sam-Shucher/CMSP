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

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mockAdminApi(handler: Handler = () => undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === '/api/admin/approved-emails') return jsonResponse(EMAILS);
    if (url === '/api/admin/users')            return jsonResponse(USERS);
    return jsonResponse({ message: 'ok' });
  }));
}

function errorResponse(error: string): Response {
  return { ok: false, json: async () => ({ error }) } as Response;
}

function rowFor(text: string): HTMLElement {
  return screen.getAllByRole('row').find(r => r.textContent?.includes(text))!;
}

describe('AdminPage — invite list', () => {
  it('adds an email, confirms it, clears the box, and refreshes the list', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('friend@example.com');

    await userEvent.type(screen.getByPlaceholderText('friend@example.com'), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /add email/i }));

    expect(await screen.findByText(/new@example\.com added to the invite list/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('friend@example.com')).toHaveValue('');
    expect(fetch).toHaveBeenCalledWith('/api/admin/approved-emails', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ email: 'new@example.com' }),
    }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([u]) => u === '/api/admin/approved-emails' ).length).toBeGreaterThanOrEqual(3));
  });

  it('shows the server\'s error for a duplicate email and keeps what was typed', async () => {
    mockAdminApi((url, init) => url === '/api/admin/approved-emails' && init?.method === 'POST'
      ? errorResponse("Email already on this collection's invite list") : undefined);
    renderAdminPage();
    await screen.findByText('friend@example.com');

    await userEvent.type(screen.getByPlaceholderText('friend@example.com'), 'friend@example.com');
    await userEvent.click(screen.getByRole('button', { name: /add email/i }));

    expect(await screen.findByText(/already on this collection's invite list/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText('friend@example.com')).toHaveValue('friend@example.com');
  });

  it('shows an empty state when nobody has been invited', async () => {
    mockAdminApi((url) => url === '/api/admin/approved-emails' ? jsonResponse([]) : undefined);
    renderAdminPage();

    expect(await screen.findByText(/no approved emails yet/i)).toBeInTheDocument();
  });

  it('shows who added each invite, or a dash if it was added directly in the database', async () => {
    mockAdminApi((url) => url === '/api/admin/approved-emails'
      ? jsonResponse([{ ...EMAILS[0], added_by_username: null }]) : undefined);
    renderAdminPage();
    await screen.findByText('friend@example.com');

    expect(within(rowFor('friend@example.com')).getByText('—')).toBeInTheDocument();
  });

  it('shows an error if the admin data fails to load', async () => {
    mockAdminApi((url) => url === '/api/admin/users' ? errorResponse('You are not a member of this collection') : undefined);
    renderAdminPage();

    expect(await screen.findByText(/not a member of this collection/i)).toBeInTheDocument();
  });
});

describe('AdminPage — roles', () => {
  it('asks for confirmation, then promotes a user to admin', async () => {
    mockAdminApi();
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /make admin/i }));

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/admin/));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/users/2/role', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ role: 'admin' }),
    })));
  });

  it('demotes another admin back to member', async () => {
    mockAdminApi((url, init) => url === '/api/admin/users' && !init?.method
      ? jsonResponse([USERS[0], { ...USERS[1], role: 'admin' }]) : undefined);
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt@example.com')).getByRole('button', { name: /demote/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/users/2/role', expect.objectContaining({
      body: JSON.stringify({ role: 'user' }),
    })));
  });

  it('changes nothing if the confirmation is declined', async () => {
    mockAdminApi();
    vi.stubGlobal('confirm', vi.fn(() => false));
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /make admin/i }));

    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/role'), expect.anything());
  });

  it('shows the server\'s error if the role change fails', async () => {
    mockAdminApi((url) => url.endsWith('/role') ? errorResponse('User not found') : undefined);
    vi.stubGlobal('confirm', vi.fn(() => true));
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /make admin/i }));

    expect(await screen.findByText('User not found')).toBeInTheDocument();
  });
});

describe('AdminPage — your own row', () => {
  it('offers no role change for yourself, so you can\'t lock yourself out', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('grunt');

    expect(within(rowFor('boss@example.com')).queryByRole('button', { name: /demote|make admin/i })).not.toBeInTheDocument();
    expect(within(rowFor('grunt@example.com')).getByRole('button', { name: /make admin/i })).toBeInTheDocument();
  });

  it('labels roles as they apply to this group', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('grunt');

    expect(within(rowFor('boss@example.com')).getByText('Admin')).toBeInTheDocument();
    expect(within(rowFor('grunt@example.com')).getByText('Member')).toBeInTheDocument();
  });
});

describe('AdminPage — failed deletes', () => {
  it('closes the confirm box and shows the server\'s error if removing a member fails', async () => {
    mockAdminApi((url, init) => url === '/api/admin/users/2' && init?.method === 'DELETE'
      ? errorResponse('User not found in this collection') : undefined);
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /remove from group/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'grunt');
    await userEvent.click(screen.getByRole('button', { name: /^confirm delete$/i }));

    expect(await screen.findByText(/user not found in this collection/i)).toBeInTheDocument();
    expect(screen.queryByTestId('confirm-delete-modal')).not.toBeInTheDocument();
  });

  it('cancelling the confirm box deletes nothing', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('friend@example.com');

    await userEvent.click(screen.getByRole('button', { name: /^remove$/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByTestId('confirm-delete-modal')).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ method: 'DELETE' }));
  });
});

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
