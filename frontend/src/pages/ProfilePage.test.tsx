import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ProfilePage from './ProfilePage';

const PROFILE = {
  id: 1,
  email: 'owner@example.com',
  username: 'owner',
  display_name: 'Owner Name',
  phone: '555-1234',
  neighborhood: 'Riverside',
  role: 'user',
};

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

  it('rejects a blank display name and does not call the API to save', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => PROFILE } as Response);

    render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    const nameInput = await screen.findByDisplayValue('Owner Name');

    await userEvent.clear(nameInput);
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/display name is required/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1); // only the initial GET, no PATCH
  });
});
