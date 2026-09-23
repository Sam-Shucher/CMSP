import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import UploadMiniPage from './UploadMiniPage';

describe('UploadMiniPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('prefills the description with a manufacturer/scale/series template', () => {
    render(<MemoryRouter><UploadMiniPage /></MemoryRouter>);
    expect(screen.getByLabelText(/description/i)).toHaveValue('Manufacturer: \nScale: \nSeries: \n');
  });

  it('submits the form as multipart data including the description template', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: 'Mini added', miniId: 1 }),
    } as Response);

    render(<MemoryRouter><UploadMiniPage /></MemoryRouter>);
    await userEvent.type(screen.getByLabelText(/name/i), 'Dire Wolf');
    await userEvent.click(screen.getByRole('button', { name: /add to collection/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, options] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/minis');
    expect(options?.method).toBe('POST');
    expect(options?.body).toBeInstanceOf(FormData);
  });

  it('includes tags, price, and photos when given, and returns to the dashboard', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ miniId: 1 }) } as Response);
    render(
      <MemoryRouter initialEntries={['/upload']}>
        <Routes>
          <Route path="/upload" element={<UploadMiniPage />} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>
    );

    await userEvent.type(screen.getByLabelText(/name/i), 'Dire Wolf');
    await userEvent.type(screen.getByLabelText(/tags/i), 'boss, painted');
    await userEvent.type(screen.getByLabelText(/price/i), '12.5');
    const photo = new File(['x'], 'wolf.png', { type: 'image/png' });
    await userEvent.upload(screen.getByTestId('image-input'), photo);
    await userEvent.click(screen.getByRole('button', { name: /add to collection/i }));

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(body.get('tags')).toBe('boss, painted');
    expect(body.get('price')).toBe('12.5');
    expect(body.getAll('images')).toHaveLength(1);
  });

  it('leaves out blank optional fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ miniId: 1 }) } as Response);
    render(<MemoryRouter><UploadMiniPage /></MemoryRouter>);

    await userEvent.type(screen.getByLabelText(/name/i), 'Dire Wolf');
    await userEvent.clear(screen.getByLabelText(/description/i));
    await userEvent.click(screen.getByRole('button', { name: /add to collection/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = vi.mocked(fetch).mock.calls[0][1]?.body as FormData;
    expect(body.has('description')).toBe(false);
    expect(body.has('tags')).toBe(false);
    expect(body.has('price')).toBe(false);
  });

  it('points to adding several at once, for a whole shelf', () => {
    render(<MemoryRouter><UploadMiniPage /></MemoryRouter>);

    expect(screen.getByRole('link', { name: /add several at once/i })).toHaveAttribute('href', '/upload/bulk');
  });

  it('shows the server\'s error and stays on the page', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Only image files are allowed (jpg, png, gif, webp)' }) } as Response);
    render(<MemoryRouter><UploadMiniPage /></MemoryRouter>);

    await userEvent.type(screen.getByLabelText(/name/i), 'Dire Wolf');
    await userEvent.click(screen.getByRole('button', { name: /add to collection/i }));

    expect(await screen.findByText(/only image files are allowed/i)).toBeInTheDocument();
  });
});
