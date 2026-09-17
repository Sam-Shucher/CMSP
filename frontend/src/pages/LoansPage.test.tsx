import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import LoansPage from './LoansPage';
import { Loan } from '../api/client';

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
