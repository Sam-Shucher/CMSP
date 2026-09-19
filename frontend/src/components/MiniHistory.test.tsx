import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import MiniHistory from './MiniHistory';
import { MiniHistoryEntry } from '../api/client';
import { jsonResponse, urlOf } from '../test/apiMock';

function entry(overrides: Partial<MiniHistoryEntry> = {}): MiniHistoryEntry {
  return {
    loanId: 1,
    borrowerId: 2,
    borrowerUsername: 'bruno',
    borrowerName: 'Bruno Borrower',
    handedOffAt: '2026-08-01T18:00:00.000Z',
    returnedAt: '2026-08-08T18:00:00.000Z',
    ongoing: false,
    daysOut: 7,
    ...overrides,
  };
}

describe('MiniHistory', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('starts collapsed, and fetches nothing until asked', () => {
    render(<MiniHistory miniId={42} />);

    expect(screen.getByRole('button', { name: /view lending history/i })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches and shows the list when opened', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([entry()]));

    render(<MiniHistory miniId={42} />);
    await userEvent.click(screen.getByRole('button', { name: /view lending history/i }));

    expect(urlOf(vi.mocked(fetch).mock.calls[0][0])).toBe('/api/minis/42/history');
    expect(await screen.findByText('Bruno Borrower')).toBeInTheDocument();
    expect(screen.getByText(/lent out 1 time\b/i)).toBeInTheDocument();
  });

  it('says so plainly when nobody has borrowed it yet', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([]));

    render(<MiniHistory miniId={42} />);
    await userEvent.click(screen.getByRole('button', { name: /view lending history/i }));

    expect(await screen.findByText(/nobody's borrowed this one yet/i)).toBeInTheDocument();
  });

  it('counts more than one loan in the plural', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([entry({ loanId: 1 }), entry({ loanId: 2, borrowerUsername: 'wendy' })]));

    render(<MiniHistory miniId={42} />);
    await userEvent.click(screen.getByRole('button', { name: /view lending history/i }));

    expect(await screen.findByText(/lent out 2 times/i)).toBeInTheDocument();
  });

  it('marks a loan that is still out as ongoing, without a return date', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([
      entry({ ongoing: true, returnedAt: null, daysOut: 3 }),
    ]));

    render(<MiniHistory miniId={42} />);
    await userEvent.click(screen.getByRole('button', { name: /view lending history/i }));

    expect(await screen.findByText(/still out/i)).toBeInTheDocument();
  });

  it('collapses again without fetching a second time', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse([entry()]));

    render(<MiniHistory miniId={42} />);
    const button = screen.getByRole('button', { name: /view lending history/i });
    await userEvent.click(button);
    await screen.findByText('Bruno Borrower');

    await userEvent.click(screen.getByRole('button', { name: /hide lending history/i }));
    expect(screen.queryByText('Bruno Borrower')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /view lending history/i }));
    expect(await screen.findByText('Bruno Borrower')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shows the server\'s message if it can\'t be loaded, without breaking the page around it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(
      { error: 'Only the owner can see this mini\'s lending history' }, { ok: false, status: 403 }
    ));

    render(<MiniHistory miniId={42} />);
    await userEvent.click(screen.getByRole('button', { name: /view lending history/i }));

    expect(await screen.findByText(/only the owner can see/i)).toBeInTheDocument();
  });
});
