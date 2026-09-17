import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LoansPage from './LoansPage';
import { Loan, LOANS_CHANGED_EVENT } from '../api/client';

const ALICE = { id: 10, username: 'alice', displayName: 'Alice' };
const BOB = { id: 20, username: 'bob', displayName: 'Bob' };

let nextId = 1;
function makeLoan(overrides: Partial<Loan> = {}): Loan {
  const id = nextId++;
  return {
    id,
    miniId: 100 + id,
    miniName: `Mini ${id}`,
    miniImage: null,
    role: 'borrower',
    counterpart: ALICE,
    status: 'negotiating',
    stage: 'negotiating',
    handoffWhen: '2026-10-01T18:30:00.000Z',
    handoffWhere: 'Game night',
    handoffHow: 'In person',
    durationDays: 7,
    borrowerApproved: false,
    ownerApproved: false,
    handedOffAt: null,
    receivedAt: null,
    dueAt: null,
    returnedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, statusText: ok ? 'OK' : 'Error', json: async () => body } as Response;
}

function mockLoans(...responses: Loan[][]): void {
  const queue = [...responses];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/loans' && method === 'GET') {
      return jsonResponse(queue.length > 1 ? queue.shift() : queue[0]);
    }
    return jsonResponse({});
  });
}

function renderLoans() {
  return render(
    <MemoryRouter>
      <LoansPage />
    </MemoryRouter>
  );
}

describe('LoansPage — holds', () => {
  const HOLDS = {
    holds: [
      { miniId: 42, miniName: 'Dire Wolf', miniImage: null, ownerName: 'Alice', position: 2, status: 'adventuring' },
    ],
    watching: [
      { miniId: 43, miniName: 'Owlbear', holdCount: 3 },
    ],
  };

  function mockHolds(holds: unknown, loans: Loan[] = []) {
    let current = holds;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(input)}`;
      if (key === 'GET /api/loans') return jsonResponse(loans);
      if (key === 'GET /api/holds') return jsonResponse(current);
      if (key === 'DELETE /api/holds/minis/42') {
        current = { ...HOLDS, holds: [] };
        return jsonResponse({ message: 'Left the line' });
      }
      if (key === 'DELETE /api/holds/minis/43/watch') {
        current = { ...HOLDS, watching: [] };
        return jsonResponse({ watching: false });
      }
      return jsonResponse({ error: `unexpected ${key}` }, false);
    });
  }

  beforeEach(() => {
    nextId = 1;
    vi.stubGlobal('fetch', vi.fn());
  });

  it('lists the minis you\'re waiting for, with your place in line', async () => {
    mockHolds(HOLDS);
    renderLoans();

    const section = await screen.findByRole('region', { name: /waiting in line/i });
    expect(within(section).getByText('Dire Wolf')).toBeInTheDocument();
    expect(section).toHaveTextContent(/#2 in line/);
    expect(section).toHaveTextContent(/from Alice/);
    expect(section).toHaveTextContent(/checked out automatically/i);
  });

  it('lets you leave a line from here', async () => {
    mockHolds(HOLDS);
    renderLoans();

    await userEvent.click(await screen.findByRole('button', { name: /leave the line for dire wolf/i }));

    await waitFor(() => expect(screen.queryByText('Dire Wolf')).not.toBeInTheDocument());
  });

  it('lists full lines you asked to hear about, and lets you stop', async () => {
    mockHolds(HOLDS);
    renderLoans();

    const section = await screen.findByRole('region', { name: /notify me/i });
    expect(within(section).getByText('Owlbear')).toBeInTheDocument();

    await userEvent.click(within(section).getByRole('button', { name: /stop notifying me about owlbear/i }));

    await waitFor(() => expect(screen.queryByRole('region', { name: /notify me/i })).not.toBeInTheDocument());
  });

  it('does not count as "nothing here" when you have holds but no loans', async () => {
    mockHolds(HOLDS);
    renderLoans();

    await screen.findByRole('region', { name: /waiting in line/i });
    expect(screen.queryByText(/no requests or loans yet/i)).not.toBeInTheDocument();
  });

  it('hides the holds sections when you have none', async () => {
    mockHolds({ holds: [], watching: [] }, [makeLoan({ miniName: 'Beholder' })]);
    renderLoans();

    await screen.findByText('Beholder');
    expect(screen.queryByRole('region', { name: /waiting in line/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /notify me/i })).not.toBeInTheDocument();
  });
});

describe('LoansPage — keeping up with the other person', () => {
  beforeEach(() => {
    nextId = 1;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // First load shows Bob hasn't approved; every later load shows he has.
  function mockChangingLoans() {
    mockLoans(
      [makeLoan({ miniName: 'Dire Wolf', role: 'owner', counterpart: BOB, ownerApproved: true })],
      [makeLoan({ miniName: 'Dire Wolf', role: 'owner', counterpart: BOB, ownerApproved: true, borrowerApproved: true, stage: 'agreed' })],
    );
  }

  it('reloads when a notification is opened (even while already on this page)', async () => {
    mockChangingLoans();
    renderLoans();
    await screen.findByText(/waiting on bob/i);

    act(() => { window.dispatchEvent(new Event(LOANS_CHANGED_EVENT)); });

    expect(await screen.findByRole('button', { name: 'Confirm handoff' })).toBeInTheDocument();
  });

  it('reloads when you come back to the tab', async () => {
    mockChangingLoans();
    renderLoans();
    await screen.findByText(/waiting on bob/i);

    act(() => { window.dispatchEvent(new Event('focus')); });

    expect(await screen.findByRole('button', { name: 'Confirm handoff' })).toBeInTheDocument();
  });

  it('checks for changes on its own every 30 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockChangingLoans();
    renderLoans();
    await screen.findByText(/waiting on bob/i);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(await screen.findByRole('button', { name: 'Confirm handoff' })).toBeInTheDocument();
  });
});

describe('LoansPage', () => {
  beforeEach(() => {
    nextId = 1;
    vi.stubGlobal('fetch', vi.fn());
  });

  it('shows an empty state when you have no requests or loans', async () => {
    mockLoans([]);
    renderLoans();

    expect(await screen.findByText(/no requests or loans yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /browse/i })).toHaveAttribute('href', '/');
  });

  it('separates what you are borrowing from what you are lending, grouped by person', async () => {
    mockLoans([
      makeLoan({ miniName: 'Dire Wolf', role: 'borrower', counterpart: ALICE }),
      makeLoan({ miniName: 'Owlbear', role: 'borrower', counterpart: BOB }),
      makeLoan({ miniName: 'Beholder', role: 'owner', counterpart: BOB }),
    ]);
    renderLoans();

    const borrowing = await screen.findByRole('region', { name: /borrowing/i });
    const lending = screen.getByRole('region', { name: /lending/i });

    expect(within(within(borrowing).getByRole('region', { name: /with alice/i })).getByText('Dire Wolf')).toBeInTheDocument();
    expect(within(within(borrowing).getByRole('region', { name: /with bob/i })).getByText('Owlbear')).toBeInTheDocument();
    expect(within(lending).getByText('Beholder')).toBeInTheDocument();
    expect(within(lending).queryByText('Dire Wolf')).not.toBeInTheDocument();
  });

  it('puts returned and cancelled loans in history, away from the active ones', async () => {
    mockLoans([
      makeLoan({ miniName: 'Active One' }),
      makeLoan({ miniName: 'Came Home', status: 'returned', stage: 'returned', returnedAt: '2026-09-10T00:00:00.000Z' }),
      makeLoan({ miniName: 'Called Off', status: 'cancelled', stage: 'cancelled' }),
    ]);
    renderLoans();

    const history = await screen.findByRole('region', { name: /history/i });
    const borrowing = screen.getByRole('region', { name: /borrowing/i });

    expect(within(history).getByText('Came Home')).toBeInTheDocument();
    expect(within(history).getByText('Called Off')).toBeInTheDocument();
    expect(within(borrowing).queryByText('Came Home')).not.toBeInTheDocument();
    expect(within(borrowing).getByText('Active One')).toBeInTheDocument();
  });

  it('offers "apply to all" only when there are several open requests with the same person', async () => {
    mockLoans([
      makeLoan({ miniName: 'Dire Wolf', counterpart: ALICE }),
      makeLoan({ miniName: 'Owlbear', counterpart: ALICE }),
      makeLoan({ miniName: 'Beholder', counterpart: BOB }),
    ]);
    renderLoans();

    await screen.findByText('Beholder');
    expect(screen.getAllByRole('button', { name: /apply these terms to all requests with alice/i })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /apply these terms to all requests with bob/i })).not.toBeInTheDocument();
  });

  it('does not count someone\'s requests on the other side of the desk toward "apply to all"', async () => {
    mockLoans([
      makeLoan({ miniName: 'Dire Wolf', role: 'borrower', counterpart: BOB }),
      makeLoan({ miniName: 'Beholder', role: 'owner', counterpart: BOB }),
    ]);
    renderLoans();

    await screen.findByText('Beholder');
    expect(screen.queryByRole('button', { name: /apply these terms/i })).not.toBeInTheDocument();
  });

  it('reloads the list after an action so both sides see fresh status', async () => {
    mockLoans(
      [makeLoan({ miniName: 'Dire Wolf', ownerApproved: true })],
      [makeLoan({ miniName: 'Dire Wolf', ownerApproved: true, borrowerApproved: true, stage: 'agreed' })],
    );
    renderLoans();

    await userEvent.click(await screen.findByRole('button', { name: /approve terms/i }));

    await waitFor(() => expect(screen.getByText(/will confirm the handoff/i)).toBeInTheDocument());
  });

  it('shows an error if loans fail to load', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Server error' }, false));
    renderLoans();

    expect(await screen.findByText(/server error/i)).toBeInTheDocument();
  });
});
