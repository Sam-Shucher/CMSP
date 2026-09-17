import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import HoldPanel from './HoldPanel';
import { HoldSummary } from '../api/client';
import { jsonResponse, urlOf} from '../test/apiMock';

// Serves the summary from a mutable value so actions can change what comes back next.
function mockHoldsApi(initial: HoldSummary, actions: Record<string, () => Response> = {}) {
  let summary = initial;
  const setSummary = (next: HoldSummary) => { summary = next; };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${urlOf(input)}`;
    if (actions[key]) return actions[key]();
    if (key === 'GET /api/holds/minis/42') return jsonResponse(summary);
    return jsonResponse({ error: `unexpected ${key}` }, { ok: false });
  });
  return { setSummary };
}

const EMPTY: HoldSummary = { max: 3, count: 0, position: null, watching: false };

describe('HoldPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('shows nothing for an available mini — you just add it to your cart', () => {
    render(<HoldPanel miniId={42} status="available" isOwn={false} />);

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows how full the line is and offers a hold when there\'s room', async () => {
    mockHoldsApi({ ...EMPTY, count: 1 });
    render(<HoldPanel miniId={42} status="adventuring" isOwn={false} />);

    expect(await screen.findByText(/1 of 3 holds/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /place a hold/i })).toBeInTheDocument();
    expect(screen.getByText(/first person in line is checked out automatically/i)).toBeInTheDocument();
  });

  it('places a hold and then shows your place in line', async () => {
    const { setSummary } = mockHoldsApi(EMPTY, {
      'POST /api/holds/minis/42': () => {
        setSummary({ ...EMPTY, count: 1, position: 1 });
        return jsonResponse({ position: 1 });
      },
    });
    render(<HoldPanel miniId={42} status="requested" isOwn={false} />);

    await userEvent.click(await screen.findByRole('button', { name: /place a hold/i }));

    expect(await screen.findByText(/you're #1 in line/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /leave the line/i })).toBeInTheDocument();
  });

  it('lets you leave the line', async () => {
    const { setSummary } = mockHoldsApi({ ...EMPTY, count: 2, position: 2 }, {
      'DELETE /api/holds/minis/42': () => {
        setSummary({ ...EMPTY, count: 1 });
        return jsonResponse({ message: 'Left the line' });
      },
    });
    render(<HoldPanel miniId={42} status="adventuring" isOwn={false} />);

    await userEvent.click(await screen.findByRole('button', { name: /leave the line/i }));

    expect(await screen.findByRole('button', { name: /place a hold/i })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/holds/minis/42', expect.objectContaining({ method: 'DELETE' }));
  });

  it('offers the notify list when the line is full', async () => {
    const { setSummary } = mockHoldsApi({ ...EMPTY, count: 3 }, {
      'POST /api/holds/minis/42/watch': () => {
        setSummary({ ...EMPTY, count: 3, watching: true });
        return jsonResponse({ watching: true });
      },
    });
    render(<HoldPanel miniId={42} status="adventuring" isOwn={false} />);

    expect(await screen.findByText(/the line is full/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /place a hold/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /notify me when a spot opens/i }));

    expect(await screen.findByText(/we'll let you know when a spot opens/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop notifying me/i })).toBeInTheDocument();
  });

  it('lets you leave the notify list', async () => {
    const { setSummary } = mockHoldsApi({ ...EMPTY, count: 3, watching: true }, {
      'DELETE /api/holds/minis/42/watch': () => {
        setSummary({ ...EMPTY, count: 3 });
        return jsonResponse({ watching: false });
      },
    });
    render(<HoldPanel miniId={42} status="adventuring" isOwn={false} />);

    await userEvent.click(await screen.findByRole('button', { name: /stop notifying me/i }));

    expect(await screen.findByRole('button', { name: /notify me when a spot opens/i })).toBeInTheDocument();
  });

  it('shows the server\'s reason when a hold is refused (e.g. someone just took the last spot)', async () => {
    mockHoldsApi({ ...EMPTY, count: 2 }, {
      'POST /api/holds/minis/42': () => jsonResponse({ error: 'The hold line is full (3 people)', code: 'full' }, { ok: false }),
    });
    render(<HoldPanel miniId={42} status="adventuring" isOwn={false} />);

    await userEvent.click(await screen.findByRole('button', { name: /place a hold/i }));

    expect(await screen.findByText(/the hold line is full/i)).toBeInTheDocument();
  });

  it('shows the owner who is waiting, in order — and no hold buttons', async () => {
    mockHoldsApi({ ...EMPTY, count: 2, queue: [{ position: 1, displayName: 'Alice' }, { position: 2, displayName: 'Bob' }] });
    render(<HoldPanel miniId={42} status="adventuring" isOwn />);

    const list = await screen.findByRole('list', { name: /waiting in line/i });
    expect(list).toHaveTextContent(/1\.\s*Alice/);
    expect(list).toHaveTextContent(/2\.\s*Bob/);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('tells the owner when nobody is waiting', async () => {
    mockHoldsApi({ ...EMPTY, queue: [] });
    render(<HoldPanel miniId={42} status="on_quest" isOwn />);

    expect(await screen.findByText(/nobody is waiting/i)).toBeInTheDocument();
  });

  it('stays out of the way if the line can\'t be loaded', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Server error' }, { ok: false }));
    render(<HoldPanel miniId={42} status="adventuring" isOwn={false} />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
