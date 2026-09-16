import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import EditMiniPage from './EditMiniPage';

function renderEditPage() {
  return render(
    <MemoryRouter initialEntries={['/minis/42/edit']}>
      <Routes>
        <Route path="/minis/:id/edit" element={<EditMiniPage />} />
        <Route path="/" element={<div>Dashboard</div>} />
      </Routes>
    </MemoryRouter>
  );
}

const MINI = {
  id: 42,
  name: 'Dire Wolf',
  description: 'A wolf',
  images: ['/uploads/wolf.png'],
  price: 12.5,
  available: true,
  owner_name: 'Owner Name',
  owner_username: 'owner',
  owner_id: 1,
  tags: ['dragon', 'painted'],
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('EditMiniPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('loads the mini and prefills the form', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response);

    renderEditPage();

    expect(await screen.findByLabelText(/name/i)).toHaveValue('Dire Wolf');
    expect(screen.getByLabelText(/description/i)).toHaveValue('A wolf');
    expect(screen.getByLabelText(/tags/i)).toHaveValue('dragon,painted');
    expect(screen.getByLabelText(/price/i)).toHaveValue(12.5);
  });

  it('submits changes as a PATCH request and navigates back to the dashboard', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response) // initial GET
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MINI, name: 'Renamed Wolf' }) } as Response); // PATCH

    renderEditPage();
    await screen.findByLabelText(/name/i);

    const nameInput = screen.getByLabelText(/name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed Wolf');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const [url, options] = vi.mocked(fetch).mock.calls[1];
    expect(url).toBe('/api/minis/42');
    expect(options?.method).toBe('PATCH');
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('shows an error message when the server rejects the edit (e.g. not the owner)', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'You can only edit your own minis' }) } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/you can only edit your own minis/i)).toBeInTheDocument();
  });
});
