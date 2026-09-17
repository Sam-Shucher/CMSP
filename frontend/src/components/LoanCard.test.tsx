import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoanCard from './LoanCard';
import { Loan } from '../api/client';
import { fromDateTimeLocalValue } from '../utils/loanTime';

const DAY = 24 * 60 * 60 * 1000;

function makeLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 7,
    miniId: 1,
    miniName: 'Dire Wolf',
    miniImage: null,
    role: 'borrower',
    counterpart: { id: 10, username: 'alice', displayName: 'Alice' },
    status: 'negotiating',
    stage: 'negotiating',
    handoffWhen: null,
    handoffWhere: null,
    handoffHow: null,
    durationDays: null,
    borrowerApproved: false,
    ownerApproved: false,
    handedOffAt: null,
    dueAt: null,
    returnedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const COMPLETE_TERMS: Partial<Loan> = {
  handoffWhen: '2026-10-01T18:30:00.000Z',
  handoffWhere: 'Game night at the shop',
  handoffHow: 'In person',
  durationDays: 14,
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, statusText: ok ? 'OK' : 'Error', json: async () => body } as Response;
}

function lastRequest(): { url: string; method: string; body: unknown } {
  const [input, init] = vi.mocked(fetch).mock.calls.at(-1)!;
  return {
    url: String(input),
    method: init?.method ?? 'GET',
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

function renderCard(loan: Loan, props: { otherOpenRequests?: number; onUpdated?: () => void } = {}) {
  const onUpdated = props.onUpdated ?? vi.fn();
  render(<LoanCard loan={loan} now={new Date()} otherOpenRequests={props.otherOpenRequests ?? 0} onUpdated={onUpdated} />);
  return { onUpdated };
}

describe('LoanCard — negotiating terms', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
  });

  it('lets the borrower propose when, where, and how — but not the duration', async () => {
    const { onUpdated } = renderCard(makeLoan());

    expect(screen.queryByLabelText(/duration/i)).not.toBeInTheDocument();
    expect(screen.getByText(/hasn't proposed a duration/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/when/i), '2026-10-01T18:30');
    await userEvent.type(screen.getByLabelText(/where/i), 'Game night');
    await userEvent.type(screen.getByLabelText(/how/i), 'In person');
    await userEvent.click(screen.getByRole('button', { name: /propose terms/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toEqual({
      url: '/api/loans/7/terms',
      method: 'PATCH',
      body: { when: fromDateTimeLocalValue('2026-10-01T18:30'), where: 'Game night', how: 'In person' },
    });
  });

  it('lets the owner propose and adjust the duration', async () => {
    const { onUpdated } = renderCard(makeLoan({ role: 'owner', counterpart: { id: 20, username: 'bob', displayName: 'Bob' }, durationDays: 7 }));

    const duration = screen.getByLabelText(/duration/i);
    expect(duration).toHaveValue(7);
    await userEvent.clear(duration);
    await userEvent.type(duration, '14');
    await userEvent.click(screen.getByRole('button', { name: /propose terms/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest().body).toEqual({ durationDays: 14 });
  });

  it.each(['0', '366', '2.5'])('rejects a duration of %s days without calling the server', async (days: string) => {
    renderCard(makeLoan({ role: 'owner' }));

    await userEvent.type(screen.getByLabelText(/duration/i), days);
    await userEvent.click(screen.getByRole('button', { name: /propose terms/i }));

    expect(await screen.findByText(/whole number of days from 1 to 365/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not propose when nothing was filled in', () => {
    renderCard(makeLoan());
    expect(screen.getByRole('button', { name: /propose terms/i })).toBeDisabled();
  });

  it('shows both keys — whose approval is in and whose is not', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, borrowerApproved: true, ownerApproved: false }));

    expect(screen.getByText(/you: approved/i)).toBeInTheDocument();
    expect(screen.getByText(/alice: not yet/i)).toBeInTheDocument();
  });

  it('cannot approve until the terms are complete', () => {
    renderCard(makeLoan({ handoffWhere: 'Game night' }));
    expect(screen.getByRole('button', { name: /approve terms/i })).toBeDisabled();
  });

  it('approves complete terms', async () => {
    const { onUpdated } = renderCard(makeLoan({ ...COMPLETE_TERMS, ownerApproved: true }));

    await userEvent.click(screen.getByRole('button', { name: /approve terms/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/approve', method: 'POST' });
  });

  it('does not offer to approve again once you have — it waits on the other side', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, borrowerApproved: true }));

    expect(screen.queryByRole('button', { name: /approve terms/i })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting on alice/i)).toBeInTheDocument();
  });

  it('shows the server\'s error message when an action is refused', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'This loan is no longer being negotiated' }, false));
    const { onUpdated } = renderCard(makeLoan({ ...COMPLETE_TERMS }));

    await userEvent.click(screen.getByRole('button', { name: /approve terms/i }));

    expect(await screen.findByText(/no longer being negotiated/i)).toBeInTheDocument();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});

describe('LoanCard — apply terms to all', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ updated: 2 })));
  });

  it('offers to copy these terms onto the other open requests with the same person', async () => {
    const { onUpdated } = renderCard(makeLoan({ ...COMPLETE_TERMS }), { otherOpenRequests: 2 });

    await userEvent.click(screen.getByRole('button', { name: /apply these terms to all requests with alice/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/apply-terms-to-all', method: 'POST' });
  });

  it('does not offer it when this is the only request with that person', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS }), { otherOpenRequests: 0 });
    expect(screen.queryByRole('button', { name: /apply these terms/i })).not.toBeInTheDocument();
  });
});

describe('LoanCard — cancelling', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
  });

  it('asks for confirmation, then cancels the request', async () => {
    const { onUpdated } = renderCard(makeLoan());

    await userEvent.click(screen.getByRole('button', { name: /cancel request/i }));
    expect(fetch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /yes, cancel/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/cancel', method: 'POST' });
  });

  it('backs out of cancelling without calling the server', async () => {
    renderCard(makeLoan());

    await userEvent.click(screen.getByRole('button', { name: /cancel request/i }));
    await userEvent.click(screen.getByRole('button', { name: /keep it/i }));

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /cancel request/i })).toBeInTheDocument();
  });

  it('cannot cancel once the mini is out adventuring', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, status: 'adventuring', stage: 'adventuring', dueAt: new Date(Date.now() + 3 * DAY).toISOString() }));
    expect(screen.queryByRole('button', { name: /cancel request/i })).not.toBeInTheDocument();
  });
});

describe('LoanCard — handoff, adventuring, and return', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
  });

  const agreed: Partial<Loan> = { ...COMPLETE_TERMS, stage: 'agreed', borrowerApproved: true, ownerApproved: true };

  it('lets the owner confirm the handoff once both keys are turned', async () => {
    const { onUpdated } = renderCard(makeLoan({ ...agreed, role: 'owner' }));

    await userEvent.click(screen.getByRole('button', { name: /confirm handoff/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/handoff', method: 'POST' });
  });

  it('does not let the borrower confirm the handoff', () => {
    renderCard(makeLoan({ ...agreed, role: 'borrower' }));

    expect(screen.queryByRole('button', { name: /confirm handoff/i })).not.toBeInTheDocument();
    expect(screen.getByText(/alice will confirm the handoff/i)).toBeInTheDocument();
  });

  it('does not offer the handoff before both sides agree', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, role: 'owner', ownerApproved: true }));
    expect(screen.queryByRole('button', { name: /confirm handoff/i })).not.toBeInTheDocument();
  });

  it('shows an adventuring loan with its time remaining, to both sides', () => {
    const dueAt = new Date(Date.now() + 3 * DAY + 60 * 60 * 1000).toISOString();
    renderCard(makeLoan({ ...agreed, status: 'adventuring', stage: 'adventuring', dueAt }));

    expect(screen.getByText('Adventuring')).toBeInTheDocument();
    expect(screen.getByText(/3d \dh left/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/where/i)).not.toBeInTheDocument(); // terms are locked in
  });

  it('shows an overdue loan as overdue', () => {
    const dueAt = new Date(Date.now() - 2 * DAY).toISOString();
    renderCard(makeLoan({ ...agreed, status: 'adventuring', stage: 'overdue', dueAt }));

    expect(screen.getByText(/overdue by 2d/i)).toBeInTheDocument();
  });

  it('lets the owner mark it returned', async () => {
    const dueAt = new Date(Date.now() + DAY).toISOString();
    const { onUpdated } = renderCard(makeLoan({ ...agreed, role: 'owner', status: 'adventuring', stage: 'adventuring', dueAt }));

    await userEvent.click(screen.getByRole('button', { name: /mark returned/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/return', method: 'POST' });
  });

  it('does not let the borrower mark it returned', () => {
    const dueAt = new Date(Date.now() + DAY).toISOString();
    renderCard(makeLoan({ ...agreed, role: 'borrower', status: 'adventuring', stage: 'adventuring', dueAt }));

    expect(screen.queryByRole('button', { name: /mark returned/i })).not.toBeInTheDocument();
  });

  it('shows a finished loan without any actions', () => {
    renderCard(makeLoan({ ...agreed, status: 'returned', stage: 'returned', returnedAt: '2026-09-10T00:00:00.000Z' }));

    expect(screen.getByText('Returned')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
