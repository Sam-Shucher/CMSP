import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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
});
