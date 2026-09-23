import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminPage from './AdminPage';
import { AuthContext } from '../App';
import { jsonResponse} from '../test/apiMock';

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

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function mockAdminApi(handler: Handler = () => undefined) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const custom = handler(url, init);
    if (custom) return custom;
    if (url === '/api/admin/approved-emails') return jsonResponse(EMAILS);
    if (url === '/api/admin/users')            return jsonResponse(USERS);
    if (url === '/api/admin/archived-minis')   return jsonResponse([]);
    if (url === '/api/admin/audit-log')        return jsonResponse([]);
    if (url === '/api/admin/loan-incidents')   return jsonResponse([]);
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

describe('AdminPage — invite email checks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('turns off the browser\'s own validation popup on the invite box', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('friend@example.com');

    expect(screen.getByPlaceholderText('friend@example.com').closest('form')).toHaveAttribute('novalidate');
  });

  it('explains an incomplete email under the box and invites nobody', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('friend@example.com');

    fireEvent.change(screen.getByPlaceholderText('friend@example.com'), { target: { value: 'newfriend' } });
    fireEvent.click(screen.getByRole('button', { name: /add email/i }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email like name@example.com.');
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/approved-emails', expect.objectContaining({ method: 'POST' }));
  });

  it('asks for an address when the box is empty', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('friend@example.com');

    fireEvent.click(screen.getByRole('button', { name: /add email/i }));

    expect(screen.getByRole('alert')).toHaveTextContent('Enter the email address to invite.');
  });

  it('waits for a 3-second pause before pointing out a problem while typing', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('friend@example.com');
    vi.useFakeTimers();

    fireEvent.change(screen.getByPlaceholderText('friend@example.com'), { target: { value: 'newfr' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email like name@example.com.');
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

describe('AdminPage — resetting a forgotten password', () => {
  const RESET = {
    temporaryPassword: 'abcd-efgh-ijkl-mnop',
    displayName: 'Grunt',
    phone: '555-0101',
    expiresInDays: 7,
  };

  it('hands over the temporary password to pass on, with their phone number', async () => {
    mockAdminApi((url, init) => url === '/api/admin/users/2/reset-password' && init?.method === 'POST'
      ? jsonResponse(RESET) : undefined);
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /reset password/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'grunt');
    await userEvent.click(within(screen.getByTestId('confirm-delete-modal')).getByRole('button', { name: /^reset password$/i }));

    expect(await screen.findByText('abcd-efgh-ijkl-mnop')).toBeInTheDocument();
    expect(screen.getByText(/555-0101/)).toBeInTheDocument();
    expect(screen.getByText(/7 days/)).toBeInTheDocument();
    expect(screen.getByText(/only time/i)).toBeInTheDocument(); // shown once
  });

  it('asks for the username first, so it can\'t happen on a stray click', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /reset password/i }));

    expect(within(await screen.findByTestId('confirm-delete-modal')).getByRole('button', { name: /^reset password$/i })).toBeDisabled();
    expect(fetch).not.toHaveBeenCalledWith('/api/admin/users/2/reset-password', expect.anything());
  });

  it('offers nothing for your own row — you change yours in your profile', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('grunt');

    expect(within(rowFor('boss')).queryByRole('button', { name: /reset password/i })).not.toBeInTheDocument();
  });

  it('shows the server\'s refusal', async () => {
    mockAdminApi((url, init) => url === '/api/admin/users/2/reset-password' && init?.method === 'POST'
      ? errorResponse('User not found in this collection') : undefined);
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /reset password/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'grunt');
    await userEvent.click(within(screen.getByTestId('confirm-delete-modal')).getByRole('button', { name: /^reset password$/i }));

    expect(await screen.findByText(/user not found in this collection/i)).toBeInTheDocument();
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
      if (url === '/api/admin/archived-minis')   return Promise.resolve(jsonResponse([]));
      if (url === '/api/admin/audit-log')        return Promise.resolve(jsonResponse([]));
      if (url === '/api/admin/loan-incidents')   return Promise.resolve(jsonResponse([]));
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

  it('says what the removal did, in the server\'s words', async () => {
    mockAdminApi((url, init) => url === '/api/admin/users/2' && init?.method === 'DELETE'
      ? jsonResponse({ message: 'Removed from this group — their 2 minis here were removed too' }) : undefined);
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /remove from group/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'grunt');
    await userEvent.click(screen.getByRole('button', { name: /^confirm delete$/i }));

    expect(await screen.findByText('Removed from this group — their 2 minis here were removed too')).toBeInTheDocument();
  });

  it('explains why a member with a mini out on loan can\'t be removed yet', async () => {
    mockAdminApi((url, init) => url === '/api/admin/users/2' && init?.method === 'DELETE'
      ? errorResponse('Grunt has 1 mini out on loan in this group — it needs to be marked returned first') : undefined);
    renderAdminPage();
    await screen.findByText('grunt');

    await userEvent.click(within(rowFor('grunt')).getByRole('button', { name: /remove from group/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'grunt');
    await userEvent.click(screen.getByRole('button', { name: /^confirm delete$/i }));

    expect(await screen.findByText(/needs to be marked returned first/)).toBeInTheDocument();
  });
});

describe('AdminPage — archived minis', () => {
  const ARCHIVED = [
    { id: 42, name: 'Dire Wolf', formerOwnerId: 9, formerOwnerName: 'Departed Dave', daysLeft: 25 },
  ];

  it('shows nothing when there\'s nothing archived', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('grunt');

    expect(screen.queryByText(/archived minis/i)).not.toBeInTheDocument();
  });

  it('lists an archived mini with its former owner and days left', async () => {
    mockAdminApi((url) => url === '/api/admin/archived-minis' ? jsonResponse(ARCHIVED) : undefined);
    renderAdminPage();

    expect(await screen.findByText('Dire Wolf')).toBeInTheDocument();
    expect(screen.getByText('Departed Dave')).toBeInTheDocument();
    expect(screen.getByText('25 days')).toBeInTheDocument();
  });

  it('disables Restore until a member is chosen', async () => {
    mockAdminApi((url) => url === '/api/admin/archived-minis' ? jsonResponse(ARCHIVED) : undefined);
    renderAdminPage();
    await screen.findByText('Dire Wolf');

    expect(screen.getByRole('button', { name: /^restore$/i })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText(/give dire wolf to/i), '2');
    expect(screen.getByRole('button', { name: /^restore$/i })).toBeEnabled();
  });

  it('restores to the chosen member once confirmed, and shows the server\'s message', async () => {
    mockAdminApi((url, init) => {
      if (url === '/api/admin/archived-minis') return jsonResponse(ARCHIVED);
      if (url === '/api/admin/archived-minis/42/restore' && init?.method === 'POST') return jsonResponse({ message: 'Restored to Grunt' });
      return undefined;
    });
    renderAdminPage();
    await screen.findByText('Dire Wolf');

    await userEvent.selectOptions(screen.getByLabelText(/give dire wolf to/i), '2');
    await userEvent.click(screen.getByRole('button', { name: /^restore$/i }));
    const confirmButton = await screen.findByRole('button', { name: /^confirm restore$/i });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type/i), 'Grunt');
    await userEvent.click(confirmButton);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/admin/archived-minis/42/restore',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ newOwnerId: 2 }) })
    ));
    expect(await screen.findByText('Restored to Grunt')).toBeInTheDocument();
  });

  it('shows the server\'s refusal if the restore fails', async () => {
    mockAdminApi((url, init) => {
      if (url === '/api/admin/archived-minis') return jsonResponse(ARCHIVED);
      if (url === '/api/admin/archived-minis/42/restore' && init?.method === 'POST') return errorResponse('Archived mini not found');
      return undefined;
    });
    renderAdminPage();
    await screen.findByText('Dire Wolf');

    await userEvent.selectOptions(screen.getByLabelText(/give dire wolf to/i), '2');
    await userEvent.click(screen.getByRole('button', { name: /^restore$/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'Grunt');
    await userEvent.click(screen.getByRole('button', { name: /^confirm restore$/i }));

    expect(await screen.findByText('Archived mini not found')).toBeInTheDocument();
  });
});

describe('AdminPage — audit log', () => {
  const ENTRIES = [
    { id: 1, action: 'member_removed', actorName: 'Boss', targetName: 'Grunt', details: 'Removed Grunt from the group', createdAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('shows nothing when the log is empty', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('grunt');

    expect(screen.queryByText(/audit log/i)).not.toBeInTheDocument();
  });

  it('shows each entry\'s details', async () => {
    mockAdminApi((url) => url === '/api/admin/audit-log' ? jsonResponse(ENTRIES) : undefined);
    renderAdminPage();

    expect(await screen.findByText('Removed Grunt from the group')).toBeInTheDocument();
  });
});

describe('AdminPage — lost & damaged tally', () => {
  const INCIDENTS = [
    { borrowerId: 2, borrowerName: 'Grunt', lostCount: 2, woundedCount: 1 },
  ];

  it('shows nothing when nobody has lost or damaged anything', async () => {
    mockAdminApi();
    renderAdminPage();
    await screen.findByText('grunt');

    expect(screen.queryByText(/lost & damaged/i)).not.toBeInTheDocument();
  });

  it('lists each borrower\'s counts', async () => {
    mockAdminApi((url) => url === '/api/admin/loan-incidents' ? jsonResponse(INCIDENTS) : undefined);
    renderAdminPage();

    const heading = await screen.findByText(/lost & damaged/i);
    const section = heading.closest('section')!;
    const row = within(section).getAllByRole('row').find(r => r.textContent?.includes('Grunt'))!;
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText('1')).toBeInTheDocument();
  });
});
