import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
    expect(screen.getByLabelText(/price/i)).toHaveValue('12.50');
  });

  it('shows the error instead of a form when the mini cannot be loaded (e.g. another collection\'s)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Mini not found' }) } as Response);

    renderEditPage();

    expect(await screen.findByText('Mini not found')).toBeInTheDocument();
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete mini/i })).not.toBeInTheDocument();
  });

  it('sends the kept photos and only the optional fields that are filled in', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MINI, description: null, tags: [], price: 0 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);
    await userEvent.clear(screen.getByLabelText(/price/i));
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const body = vi.mocked(fetch).mock.calls[1][1]?.body as FormData;
    expect(body.get('name')).toBe('Dire Wolf');
    expect(body.get('existingImages')).toBe(JSON.stringify(['/uploads/wolf.png']));
    expect(body.has('description')).toBe(false);
    expect(body.has('tags')).toBe(false);
    expect(body.has('price')).toBe(false);
  });

  it('goes back to the dashboard without saving when Cancel is clicked', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
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

  // The history section fetches nothing until asked (see MiniHistory.test.tsx
  // for its own behavior) — this just confirms the edit page wires it up with
  // the right mini id.
  it('offers the lending history, fetched only once opened', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => [] } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);
    expect(fetch).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /view lending history/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/minis/42/history');
    expect(await screen.findByText(/nobody's borrowed this one yet/i)).toBeInTheDocument();
  });
});

describe('EditMiniPage — deleting the mini', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('requires retyping the exact mini name before deleting, then navigates back to the dashboard', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response) // initial GET
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'Mini deleted' }) } as Response); // DELETE

    renderEditPage();
    await screen.findByLabelText(/name/i);

    await userEvent.click(screen.getByRole('button', { name: /^delete mini$/i }));
    const confirmButton = await screen.findByRole('button', { name: /^confirm delete$/i });
    expect(confirmButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type/i), 'Dire Wolf');
    await userEvent.click(confirmButton);

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/minis/42', expect.objectContaining({ method: 'DELETE' }))
    );
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('explains why when the server refuses the delete (e.g. the mini is out on loan), instead of silently doing nothing', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'This mini has an active request or loan — finish or cancel it first' }),
      } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);

    await userEvent.click(screen.getByRole('button', { name: /^delete mini$/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'Dire Wolf');
    await userEvent.click(screen.getByRole('button', { name: /^confirm delete$/i }));

    expect(await screen.findByText(/has an active request or loan/i)).toBeInTheDocument();
    expect(screen.queryByTestId('confirm-delete-modal')).not.toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('does not delete anything if the confirm modal is cancelled', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);

    await userEvent.click(screen.getByRole('button', { name: /^delete mini$/i }));
    const modal = await screen.findByTestId('confirm-delete-modal');
    await userEvent.click(within(modal).getByRole('button', { name: /cancel/i }));

    expect(fetch).toHaveBeenCalledTimes(1); // only the initial GET
  });
});
