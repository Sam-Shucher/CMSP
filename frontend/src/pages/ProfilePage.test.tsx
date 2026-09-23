import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ProfilePage from './ProfilePage';
import { AuthContext } from '../App';
import { jsonBodyOf } from '../test/apiMock';

const PROFILE = {
  id: 1,
  email: 'owner@example.com',
  username: 'owner',
  display_name: 'Owner Name',
  phone: '555-1234',
  neighborhood: 'Riverside',
  role: 'user',
};

describe('ProfilePage — password', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('offers a way to change your own password, and says what it does to other devices', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => PROFILE } as Response);

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await screen.findByDisplayValue('Owner Name');

    expect(screen.getByRole('heading', { name: 'Password' })).toBeInTheDocument();
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
    expect(screen.getByText(/signs you out everywhere else/i)).toBeInTheDocument();
  });
});

describe('ProfilePage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loads and displays the current profile', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response);

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByDisplayValue('Owner Name')).toBeInTheDocument();
    expect(screen.getByDisplayValue('555-1234')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Riverside')).toBeInTheDocument();
    expect(screen.getByText(/owner@example\.com/)).toBeInTheDocument();
  });

  it('saves updated profile fields', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response) // initial GET
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...PROFILE, display_name: 'New Name' }),
      } as Response); // PATCH

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    const nameInput = await screen.findByDisplayValue('Owner Name');

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'New Name');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, options] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe('/api/users/me');
    expect(options?.method).toBe('PATCH');
    expect(await screen.findByText(/profile updated/i)).toBeInTheDocument();
  });

  it('shows an error instead of loading forever when the profile cannot be loaded', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Invalid or expired session' }) } as Response);

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);

    expect(await screen.findByText(/invalid or expired session/i)).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });

  it('shows the server\'s error when saving fails, and no success message', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Server error' }) } as Response);

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await screen.findByDisplayValue('Owner Name');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText('Server error')).toBeInTheDocument();
    expect(screen.queryByText(/profile updated/i)).not.toBeInTheDocument();
  });

  it('sends the phone and neighborhood too', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response);

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    const phone = await screen.findByDisplayValue('555-1234');
    await userEvent.clear(phone);
    await userEvent.type(phone, '555-9999');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(jsonBodyOf(vi.mocked(fetch).mock.calls[1][1])).toEqual({
      displayName: 'Owner Name', phone: '555-9999', neighborhood: 'Riverside',
    });
  });

  it('logs out everywhere after confirming, then returns to sign in', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'Logged out everywhere' }) } as Response);
    const setUser = vi.fn();
    render(
      <MemoryRouter initialEntries={['/profile']}>
        <AuthContext.Provider value={{ user: { userId: 1, username: 'owner', role: 'user' }, loading: false, setUser, collections: [], selectCollection: vi.fn(), refreshSession: vi.fn() }}>
          <Routes>
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/login" element={<div>Sign in page</div>} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>
    );
    await screen.findByDisplayValue('Owner Name');

    await userEvent.click(screen.getByRole('button', { name: /log out everywhere/i }));
    expect(fetch).toHaveBeenCalledTimes(1); // asks first
    await userEvent.click(screen.getByRole('button', { name: /yes, log out everywhere/i }));

    expect(await screen.findByText('Sign in page')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/auth/logout-all', expect.objectContaining({ method: 'POST' }));
    expect(setUser).toHaveBeenCalledWith(null);
  });

  it('can back out of logging out everywhere', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response);
    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    await screen.findByDisplayValue('Owner Name');

    await userEvent.click(screen.getByRole('button', { name: /log out everywhere/i }));
    await userEvent.click(screen.getByRole('button', { name: /keep me signed in/i }));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /log out everywhere/i })).toBeInTheDocument();
  });

  it('rejects a blank display name and does not call the API to save', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response);

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    const nameInput = await screen.findByDisplayValue('Owner Name');

    await userEvent.clear(nameInput);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/display name can't be blank/i)).toBeInTheDocument();
    expect(nameInput).toHaveAttribute('aria-invalid', 'true');
    expect(fetch).toHaveBeenCalledTimes(1); // only the initial GET, no PATCH
  });
});

describe('ProfilePage — export', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  function renderIn(collectionId: number | undefined) {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => PROFILE } as Response);
    render(
      <MemoryRouter>
        <AuthContext.Provider value={{
          user: { userId: 1, username: 'owner', role: 'user', collectionId },
          loading: false,
          setUser: vi.fn(),
          collections: [{ id: 5, name: 'Chicago', role: 'user', showPrices: true }],
          selectCollection: vi.fn(),
          refreshSession: vi.fn(),
        }}>
          <ProfilePage />
        </AuthContext.Provider>
      </MemoryRouter>
    );
  }

  it('offers the group\'s minis as a download, with the group in the link', async () => {
    renderIn(5);
    await screen.findByDisplayValue('Owner Name');

    expect(screen.getByRole('heading', { name: 'Export my minis' })).toBeInTheDocument();
    expect(screen.getByText(/everything you've added to Chicago/i)).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Download my minis' });
    expect(link).toHaveAttribute('href', '/api/export?group=5');
    expect(link).toHaveAttribute('download');
  });

  it('isn\'t offered before a group is chosen', async () => {
    renderIn(undefined);
    await screen.findByDisplayValue('Owner Name');

    expect(screen.queryByRole('link', { name: 'Download my minis' })).not.toBeInTheDocument();
  });
});
