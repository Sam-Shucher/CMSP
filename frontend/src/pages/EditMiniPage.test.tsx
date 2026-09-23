import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import EditMiniPage from './EditMiniPage';
import { AuthContext } from '../App';

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

  it('sends the kept photos and only the optional text fields that are filled in', async () => {
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
    // A cleared price box is sent as empty (0 on the server), so it can be told
    // apart from a form that never had a price box at all.
    expect(body.get('price')).toBe('');
  });

  it('sends the price as it stands even when it wasn\'t touched', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const body = vi.mocked(fetch).mock.calls[1][1]?.body as FormData;
    expect(body.get('price')).toBe('12.50');
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

  // TransferMini.test.tsx covers its own behavior in full — this just confirms
  // the edit page wires it up with the mini's id/name/owner and navigates
  // away (like delete does) once a transfer actually goes through.
  it('offers transferring ownership, fetched only once opened, and returns to the dashboard once it succeeds', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response) // initial GET
      .mockResolvedValueOnce({ ok: true, json: async () => [{ id: 1, name: 'Owner Name' }, { id: 2, name: 'Other Person' }] } as Response) // collection-members
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MINI, owner_id: 2 }) } as Response); // transfer

    renderEditPage();
    await screen.findByLabelText(/name/i);
    expect(fetch).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: /^transfer ownership$/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/minis/collection-members');

    // The mini's own owner (id 1) is excluded from the recipient list.
    const select = screen.getByLabelText(/give to/i);
    expect(within(select).queryByRole('option', { name: 'Owner Name' })).not.toBeInTheDocument();

    await userEvent.selectOptions(select, '2');
    await userEvent.click(screen.getByRole('button', { name: /^transfer$/i }));
    await userEvent.type(await screen.findByLabelText(/type/i), 'Other Person');
    await userEvent.click(screen.getByRole('button', { name: /^confirm transfer$/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(vi.mocked(fetch).mock.calls[2][0]).toBe('/api/minis/42/transfer');
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });
});

// Opened while the group had prices off, saved after an admin turned them
// back on: the form never showed a price, so it must not send one — the server
// then leaves the stored price alone instead of saving it as 0.
describe('EditMiniPage — a group with prices turned off', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('has no price box and sends no price at all', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MINI, price: null }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response);

    render(
      <MemoryRouter initialEntries={['/minis/42/edit']}>
        <AuthContext.Provider value={{
          user: { userId: 1, username: 'owner', role: 'user', collectionId: 5 },
          loading: false, setUser: vi.fn(), selectCollection: vi.fn(), refreshSession: vi.fn(),
          collections: [{ id: 5, name: 'Chicago', role: 'user', showPrices: false }],
        }}>
          <Routes>
            <Route path="/minis/:id/edit" element={<EditMiniPage />} />
            <Route path="/" element={<div>Dashboard</div>} />
          </Routes>
        </AuthContext.Provider>
      </MemoryRouter>
    );
    await screen.findByLabelText(/name/i);
    expect(screen.queryByLabelText(/price/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const body = vi.mocked(fetch).mock.calls[1][1]?.body as FormData;
    expect(body.has('price')).toBe(false);
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

describe('EditMiniPage — condition (lost/critically wounded)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('shows nothing when the mini has no condition', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => MINI } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);

    expect(screen.queryByText(/marked/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear condition/i })).not.toBeInTheDocument();
  });

  it.each([
    ['lost', 'Lost'],
    ['critically_wounded', 'Critically Wounded'],
  ])('shows a banner and a Clear condition button for a %s mini', async (condition, label) => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true, json: async () => ({ ...MINI, condition, conditionSince: '2026-09-01T00:00:00.000Z' }),
    } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(/hidden from the collection until cleared/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear condition/i })).toBeInTheDocument();
  });

  it('clears the condition and updates the page from the server\'s response', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MINI, condition: 'lost', conditionSince: '2026-09-01T00:00:00.000Z' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MINI, condition: null, conditionSince: null }) } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);
    await userEvent.click(screen.getByRole('button', { name: /clear condition/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/minis/42/clear-condition', expect.objectContaining({ method: 'POST' })));
    expect(screen.queryByText(/marked/i)).not.toBeInTheDocument();
  });

  it('shows the server\'s refusal if clearing fails', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ...MINI, condition: 'critically_wounded', conditionSince: '2026-09-01T00:00:00.000Z' }) } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'This mini has no condition to clear' }) } as Response);

    renderEditPage();
    await screen.findByLabelText(/name/i);
    await userEvent.click(screen.getByRole('button', { name: /clear condition/i }));

    expect(await screen.findByText(/no condition to clear/i)).toBeInTheDocument();
  });
});
