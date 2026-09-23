import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoanCard from './LoanCard';
import { Loan } from '../api/client';
import { fromDateTimeLocalValue } from '../utils/loanTime';
import { jsonResponse, urlOf, jsonBodyOf} from '../test/apiMock';

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
    receivedAt: null,
    dueAt: null,
    returnedAt: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    holdsWaiting: 0,
    extendableDays: 0,
    ...overrides,
  };
}

const COMPLETE_TERMS: Partial<Loan> = {
  handoffWhen: '2026-10-01T18:30:00.000Z',
  handoffWhere: 'Game night at the shop',
  handoffHow: 'In person',
  durationDays: 14,
};

function lastRequest(): { url: string; method: string; body: unknown } {
  const [input, init] = vi.mocked(fetch).mock.calls.at(-1)!;
  return {
    url: urlOf(input),
    method: init?.method ?? 'GET',
    body: init?.body ? jsonBodyOf(init) : undefined,
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

  it.each(['0', '91', '2.5'])('rejects a duration of %s days without calling the server', async (days: string) => {
    renderCard(makeLoan({ role: 'owner' }));

    await userEvent.type(screen.getByLabelText(/duration/i), days);
    await userEvent.click(screen.getByRole('button', { name: /propose terms/i }));

    expect(await screen.findByText(/loans can run from 1 to 90 days/i)).toBeInTheDocument();
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

  it('cannot approve while you have unproposed edits — you\'d be approving the old terms', async () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS }));
    const approve = screen.getByRole('button', { name: /approve terms/i });
    expect(approve).toBeEnabled();

    await userEvent.clear(screen.getByLabelText(/where/i));
    await userEvent.type(screen.getByLabelText(/where/i), 'Somewhere else');

    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('title', expect.stringMatching(/propose your changes first/i));
  });

  it('does not count an unchanged handoff time as an edit', async () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS }));

    expect(screen.getByRole('button', { name: /propose terms/i })).toBeDisabled();
  });

  it('shows the mini\'s photo when it has one', () => {
    const { container } = render(
      <LoanCard loan={makeLoan({ miniImage: '/uploads/wolf.png' })} now={new Date()} otherOpenRequests={0} onUpdated={vi.fn()} />
    );
    expect(container.querySelector('img')).toHaveAttribute('src', '/uploads/wolf.png');
  });

  it('shows the duration the owner set to the borrower, read-only', () => {
    renderCard(makeLoan({ durationDays: 1 }));
    expect(screen.getByText(/loan length: 1 day \(set by alice\)/i)).toBeInTheDocument();
  });

  it('does not offer to approve again once you have — it waits on the other side', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, borrowerApproved: true }));

    expect(screen.queryByRole('button', { name: /approve terms/i })).not.toBeInTheDocument();
    expect(screen.getByText(/waiting on alice/i)).toBeInTheDocument();
  });

  it('shows the server\'s error message when an action is refused', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'This loan is no longer being negotiated' }, { ok: false }));
    const { onUpdated } = renderCard(makeLoan({ ...COMPLETE_TERMS }));

    await userEvent.click(screen.getByRole('button', { name: /approve terms/i }));

    expect(await screen.findByText(/no longer being negotiated/i)).toBeInTheDocument();
    expect(onUpdated).not.toHaveBeenCalled();
  });
});

describe('LoanCard — what to do next', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
  });

  const owner = { role: 'owner' as const, counterpart: { id: 20, username: 'bob', displayName: 'Bob' } };

  it('tells the owner how it works before anyone has approved', () => {
    renderCard(makeLoan({ ...owner }));
    expect(screen.getByText('Set the duration and agree on when, where, and how — then you both approve.')).toBeInTheDocument();
  });

  it('tells the borrower how it works before anyone has approved', () => {
    renderCard(makeLoan());
    expect(screen.getByText('Agree on when, where, and how — Alice sets the duration. Then you both approve.')).toBeInTheDocument();
  });

  it('asks you to approve when the other person already has', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, ownerApproved: true }));
    expect(screen.getByText('Alice approved these terms — approve too to agree.')).toBeInTheDocument();
  });

  it('tells the owner, while waiting, that the handoff button will appear here', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, ...owner, ownerApproved: true }));
    expect(screen.getByText('Waiting on Bob to approve. Once they do, you\'ll confirm the handoff here when you meet.')).toBeInTheDocument();
  });

  it('tells the borrower who they are waiting on', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, borrowerApproved: true }));
    expect(screen.getByText('Waiting on Alice to approve.')).toBeInTheDocument();
  });

  it('once agreed, tells the owner to confirm the handoff when they meet — right beside the button', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, ...owner, stage: 'agreed', ownerApproved: true, borrowerApproved: true }));

    expect(screen.getByText('You\'re both agreed. When you meet and hand it over, confirm the handoff.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm handoff' })).toBeInTheDocument();
  });
});

describe('LoanCard — how long a loan can run', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
  });

  const asOwner = { role: 'owner' as const, counterpart: { id: 20, username: 'bob', displayName: 'Bob' } };

  it('stops a loan longer than three months before asking the server', async () => {
    renderCard(makeLoan({ ...asOwner, durationDays: 7 }));

    await userEvent.clear(screen.getByLabelText(/duration/i));
    await userEvent.type(screen.getByLabelText(/duration/i), '120');
    await userEvent.click(screen.getByRole('button', { name: 'Propose terms' }));

    expect(await screen.findByText('Loans can run from 1 to 90 days (about 3 months)')).toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('allows exactly three months', async () => {
    const { onUpdated } = renderCard(makeLoan({ ...asOwner, durationDays: 7 }));

    await userEvent.clear(screen.getByLabelText(/duration/i));
    await userEvent.type(screen.getByLabelText(/duration/i), '90');
    await userEvent.click(screen.getByRole('button', { name: 'Propose terms' }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ body: { durationDays: 90 } });
  });

  it('says the limit on the field itself', () => {
    renderCard(makeLoan({ ...asOwner }));
    expect(screen.getByLabelText(/duration/i)).toHaveAttribute('max', '90');
  });
});

// Keeping a mini longer. A library won't renew a book somebody has reserved,
// and the hold line is this app's reservation — so when anyone is waiting, the
// offer isn't there at all, and it says why.
describe('LoanCard — keeping it longer', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})));
  });

  const out: Partial<Loan> = {
    ...COMPLETE_TERMS,
    status: 'adventuring',
    stage: 'adventuring',
    handedOffAt: '2026-10-01T18:30:00.000Z',
    dueAt: new Date(Date.now() + 5 * DAY).toISOString(),
    extendableDays: 76,
  };

  it('lets the borrower ask for more days', async () => {
    const { onUpdated } = renderCard(makeLoan(out));

    await userEvent.click(screen.getByRole('button', { name: /keep it longer/i }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/extend', method: 'POST', body: { extraDays: 7 } });
  });

  it('lets the owner give more days', async () => {
    renderCard(makeLoan({ ...out, role: 'owner' }));

    await userEvent.click(screen.getByRole('button', { name: /keep it longer/i }));

    await waitFor(() => expect(lastRequest().url).toBe('/api/loans/7/extend'));
  });

  it('sends the number of days asked for', async () => {
    renderCard(makeLoan(out));
    const days = screen.getByLabelText(/more days/i);

    await userEvent.clear(days);
    await userEvent.type(days, '14');
    await userEvent.click(screen.getByRole('button', { name: /keep it longer/i }));

    await waitFor(() => expect(lastRequest().body).toEqual({ extraDays: 14 }));
  });

  it('will not offer more days than the three months has left', () => {
    renderCard(makeLoan({ ...out, extendableDays: 4 }));

    expect(screen.getByLabelText(/more days/i)).toHaveAttribute('max', '4');
  });

  // The rule, in the interface.
  it('offers nothing while someone is in line, and says why', () => {
    renderCard(makeLoan({ ...out, holdsWaiting: 1 }));

    expect(screen.queryByRole('button', { name: /keep it longer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/someone is waiting in line/i)).toBeInTheDocument();
  });

  it('counts more than one person waiting', () => {
    renderCard(makeLoan({ ...out, holdsWaiting: 3 }));

    expect(screen.getByText(/3 people are waiting in line/i)).toBeInTheDocument();
  });

  it('says so when the full three months has been used', () => {
    renderCard(makeLoan({ ...out, extendableDays: 0 }));

    expect(screen.queryByRole('button', { name: /keep it longer/i })).not.toBeInTheDocument();
    expect(screen.getByText(/three months a loan can run/i)).toBeInTheDocument();
  });

  it('is not offered on a loan that hasn\'t been handed off, or is already back', () => {
    renderCard(makeLoan({ ...COMPLETE_TERMS, stage: 'agreed', borrowerApproved: true, ownerApproved: true, extendableDays: 76 }));
    expect(screen.queryByRole('button', { name: /keep it longer/i })).not.toBeInTheDocument();

    renderCard(makeLoan({ ...out, status: 'returned', stage: 'returned', returnedAt: '2026-10-20T00:00:00.000Z' }));
    expect(screen.queryByRole('button', { name: /keep it longer/i })).not.toBeInTheDocument();
  });

  it('shows the server\'s refusal if the line changed a moment ago', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { error: 'Someone is waiting in line for this mini, so it can\'t be kept longer — bring it back and they\'re next' },
      { ok: false, status: 409 }
    )));
    renderCard(makeLoan(out));

    await userEvent.click(screen.getByRole('button', { name: /keep it longer/i }));

    expect(await screen.findByText(/bring it back and they're next/i)).toBeInTheDocument();
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

  it.each([
    ['Lost', 'lost'],
    ['Critically Wounded', 'critically_wounded'],
  ])('lets the owner mark it %s, sending the outcome', async (buttonName, outcome) => {
    const dueAt = new Date(Date.now() + DAY).toISOString();
    const { onUpdated } = renderCard(makeLoan({ ...agreed, role: 'owner', status: 'adventuring', stage: 'adventuring', dueAt }));

    await userEvent.click(screen.getByRole('button', { name: buttonName }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/return', method: 'POST', body: { outcome } });
  });

  it('does not offer Lost/Critically Wounded buttons to the borrower', () => {
    const dueAt = new Date(Date.now() + DAY).toISOString();
    renderCard(makeLoan({ ...agreed, role: 'borrower', status: 'adventuring', stage: 'adventuring', dueAt }));

    expect(screen.queryByRole('button', { name: 'Lost' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Critically Wounded' })).not.toBeInTheDocument();
  });

  it.each([
    ['lost', /reported lost/i],
    ['critically_wounded', /reported critically wounded/i],
  ])('shows the %s outcome once the loan is over', (status, expected) => {
    renderCard(makeLoan({ status: status as Loan['status'], stage: status as Loan['stage'], returnedAt: '2026-10-05T00:00:00.000Z' }));

    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('tells the owner to clear a critically wounded mini once it\'s fine again', () => {
    renderCard(makeLoan({ role: 'owner', status: 'critically_wounded', stage: 'critically_wounded', returnedAt: '2026-10-05T00:00:00.000Z' }));

    expect(screen.getByText(/clear it from the mini's edit page/i)).toBeInTheDocument();
  });

  it('lets the borrower confirm they got it', async () => {
    const dueAt = new Date(Date.now() + DAY).toISOString();
    const { onUpdated } = renderCard(makeLoan({ ...agreed, role: 'borrower', status: 'adventuring', stage: 'adventuring', dueAt }));

    expect(screen.getByText('Have it? Let Alice know you got it.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));

    await waitFor(() => expect(onUpdated).toHaveBeenCalled());
    expect(lastRequest()).toMatchObject({ url: '/api/loans/7/received', method: 'POST' });
  });

  it('shows the borrower they already confirmed, with no button to press again', () => {
    const dueAt = new Date(Date.now() + DAY).toISOString();
    renderCard(makeLoan({ ...agreed, role: 'borrower', status: 'adventuring', stage: 'adventuring', dueAt, receivedAt: new Date().toISOString() }));

    expect(screen.getByText('✓ You confirmed you got it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument();
  });

  it('tells the owner whether the borrower has confirmed they got it — without a button for it', () => {
    const dueAt = new Date(Date.now() + DAY).toISOString();
    const owner = { role: 'owner' as const, counterpart: { id: 20, username: 'bob', displayName: 'Bob' } };
    const loan = makeLoan({ ...agreed, ...owner, status: 'adventuring', stage: 'adventuring', dueAt });

    const { unmount } = render(<LoanCard loan={loan} now={new Date()} otherOpenRequests={0} onUpdated={vi.fn()} />);
    expect(screen.getByText('Bob hasn\'t confirmed they got it yet.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument();
    unmount();

    renderCard({ ...loan, receivedAt: new Date().toISOString() });
    expect(screen.getByText('✓ Bob confirmed they got it')).toBeInTheDocument();
  });

  it('shows a finished loan without any actions', () => {
    renderCard(makeLoan({ ...agreed, status: 'returned', stage: 'returned', returnedAt: '2026-09-10T00:00:00.000Z' }));

    expect(screen.getByText('Returned')).toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
