import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Loan, MyHolds, MyBooking, MyBookings, LOANS_CHANGED_EVENT } from '../api/client';
import LoanCard from '../components/LoanCard';
import { POLL_MS, PAGE_SIZE } from '../limits';
import { usePollWhileVisible } from '../hooks/usePollWhileVisible';

// How often the "time left" countdowns re-render.
const TICK_MS = POLL_MS.clockTick;
// How often to check for changes the other person made.
const REFRESH_MS = POLL_MS.loans;

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', marginBottom: '8px',
  background: '#252219', border: '1px solid #3d3629', borderRadius: '8px',
};

function readableDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// A single day booked as itself reads as one date, not as a range of one.
function bookingSpan(booking: MyBooking): string {
  return booking.startsOn === booking.endsOn
    ? readableDay(booking.startsOn)
    : `${readableDay(booking.startsOn)} – ${readableDay(booking.endsOn)}`;
}

function isFinished(loan: Loan): boolean {
  return loan.status !== 'negotiating' && loan.status !== 'adventuring';
}

// Newest first, the way the server sends them — ties broken by id.
function newestFirst(a: Loan, b: Loan): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
}

// Adds loans to what's already known, a fresh copy replacing an older one.
function mergeFinished(known: Loan[], incoming: Loan[]): Loan[] {
  const byId = new Map(known.map((loan: Loan) => [loan.id, loan]));
  for (const loan of incoming) byId.set(loan.id, loan);
  return [...byId.values()].sort(newestFirst);
}

// Everything you're borrowing or lending in this collection. Each mini is
// its own request, grouped by the person on the other side of the desk.
export default function LoansPage(): React.ReactElement {
  const [loans, setLoans] = useState<Loan[]>([]);
  // Finished loans, kept rather than replaced on each check: the checks bring
  // only the latest page of them (GET /api/loans), and older pages come from
  // "Show older" — a loan pushed off that latest page by a newer one mustn't
  // vanish from the screen.
  const [finishedLoans, setFinishedLoans] = useState<Loan[]>([]);
  // Whether "Show older" has anything left to find: until it's been used, a
  // full latest page says there may be; after, the last older page says.
  const [latestPageFull, setLatestPageFull] = useState<boolean>(false);
  const [olderLeft, setOlderLeft] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  const [olderError, setOlderError] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [now, setNow] = useState<Date>(new Date());

  const [holds, setHolds] = useState<MyHolds>({ holds: [], watching: [] });
  const [holdError, setHoldError] = useState<string>('');
  const [bookings, setBookings] = useState<MyBookings>({ mine: [], onMyMinis: [] });

  const loadLoans = useCallback(async (): Promise<void> => {
    try {
      const data = await api<Loan[]>('/api/loans');
      const finished = data.filter(isFinished);
      setLoans(data);
      setFinishedLoans((known: Loan[]) => mergeFinished(known, finished));
      setLatestPageFull(finished.length >= PAGE_SIZE.loanHistoryPage);
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load loans');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHolds = useCallback(async (): Promise<void> => {
    try {
      const data = await api<Partial<MyHolds>>('/api/holds');
      setHolds({ holds: Array.isArray(data.holds) ? data.holds : [], watching: Array.isArray(data.watching) ? data.watching : [] });
    } catch {
      // Holds are extra here; the loans still show.
    }
  }, []);

  const loadBookings = useCallback(async (): Promise<void> => {
    try {
      const data = await api<Partial<MyBookings>>('/api/bookings');
      setBookings({
        mine: Array.isArray(data.mine) ? data.mine : [],
        onMyMinis: Array.isArray(data.onMyMinis) ? data.onMyMinis : [],
      });
    } catch {
      // Bookings are extra here too.
    }
  }, []);

  const reload = useCallback((): void => {
    void loadLoans();
    void loadHolds();
    void loadBookings();
  }, [loadLoans, loadHolds, loadBookings]);

  // The other person acts from their own screen, so keep up: reload when a
  // notification is opened, when the window gets focus back, and every so
  // often while the tab is showing (and at once when it's shown again).
  useEffect(() => {
    reload();
    window.addEventListener(LOANS_CHANGED_EVENT, reload);
    window.addEventListener('focus', reload);
    return () => {
      window.removeEventListener(LOANS_CHANGED_EVENT, reload);
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  usePollWhileVisible(reload, REFRESH_MS);

  // The next page of history, older than the oldest one shown.
  async function loadOlder(): Promise<void> {
    if (finishedLoans.length === 0) return;
    const oldest = finishedLoans[finishedLoans.length - 1];
    setLoadingOlder(true);
    setOlderError('');
    try {
      const older = await api<Loan[]>(`/api/loans/history?before=${oldest.id}`);
      setFinishedLoans((known: Loan[]) => mergeFinished(known, older));
      setOlderLeft(older.length >= PAGE_SIZE.loanHistoryPage);
    } catch (err: unknown) {
      setOlderError(err instanceof Error ? err.message : 'Failed to load older loans');
    } finally {
      setLoadingOlder(false);
    }
  }

  async function holdAction(path: string): Promise<void> {
    setHoldError('');
    try {
      await api(path, { method: 'DELETE' });
    } catch (err: unknown) {
      setHoldError(err instanceof Error ? err.message : 'Something went wrong');
    }
    await loadHolds();
  }

  async function cancelBooking(bookingId: number): Promise<void> {
    setHoldError('');
    try {
      await api(`/api/bookings/${bookingId}`, { method: 'DELETE' });
    } catch (err: unknown) {
      setHoldError(err instanceof Error ? err.message : 'Something went wrong');
    }
    await loadBookings();
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const active = loans.filter((l: Loan) => !isFinished(l));
  const history = finishedLoans;
  const canShowOlder = olderLeft ?? latestPageFull;

  // "Apply to all" copies terms between the same borrower and owner, so only
  // open requests in the same direction with the same person count.
  function otherOpenRequests(loan: Loan): number {
    return active.filter((l: Loan) =>
      l.id !== loan.id && l.status === 'negotiating' && l.role === loan.role && l.counterpart.id === loan.counterpart.id
    ).length;
  }

  function renderCard(loan: Loan): React.ReactElement {
    return (
      <LoanCard
        key={loan.id}
        loan={loan}
        now={now}
        otherOpenRequests={loan.status === 'negotiating' ? otherOpenRequests(loan) : 0}
        onUpdated={() => void loadLoans()}
      />
    );
  }

  function renderSide(title: string, role: Loan['role']): React.ReactElement | null {
    const mine = active.filter((l: Loan) => l.role === role);
    if (mine.length === 0) return null;

    const byPerson = new Map<number | null, { name: string; loans: Loan[] }>();
    for (const loan of mine) {
      const group = byPerson.get(loan.counterpart.id) ?? { name: loan.counterpart.displayName, loans: [] };
      group.loans.push(loan);
      byPerson.set(loan.counterpart.id, group);
    }

    return (
      <section aria-label={title} style={{ marginBottom: '28px' }}>
        <h3 style={{ fontSize: '17px', color: '#c9a84c', marginBottom: '12px' }}>{title}</h3>
        {[...byPerson.entries()].map(([personId, group]) => (
          <section
            key={personId ?? 'removed'}
            aria-label={`With ${group.name}`}
            style={{ background: '#252219', border: '1px solid #3d3629', borderRadius: '8px', padding: '14px', marginBottom: '14px' }}
          >
            <h4 style={{ fontSize: '14px', color: '#e8e0d0', marginBottom: '10px' }}>With {group.name}</h4>
            {group.loans.map(renderCard)}
          </section>
        ))}
      </section>
    );
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '20px' }}>Loans</h2>

      {error && <div className="error-msg" style={{ marginBottom: '16px' }}>{error}</div>}

      {holdError && <div className="error-msg" style={{ marginBottom: '16px' }}>{holdError}</div>}

      {holds.holds.length > 0 && (
        <section aria-label="Waiting in line" style={{ marginBottom: '28px' }}>
          <h3 style={{ fontSize: '17px', color: '#c9a84c', marginBottom: '4px' }}>Waiting in line</h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            When a mini comes back, the first person in line is checked out automatically — you'll get a notification.
          </p>
          {holds.holds.map(hold => (
            <div key={hold.miniId} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{hold.miniName}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  #{hold.position} in line · from {hold.ownerName}
                </div>
              </div>
              <button
                type="button"
                className="btn-secondary"
                aria-label={`Leave the line for ${hold.miniName}`}
                onClick={() => void holdAction(`/api/holds/minis/${hold.miniId}`)}
                style={{ padding: '6px 12px', fontSize: '13px' }}
              >
                Leave the line
              </button>
            </div>
          ))}
        </section>
      )}

      {(bookings.mine.length > 0 || bookings.onMyMinis.length > 0) && (
        <section aria-label="Booked days" style={{ marginBottom: '28px' }}>
          <h3 style={{ fontSize: '17px', color: '#c9a84c', marginBottom: '4px' }}>Booked days</h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px' }}>
            A booking becomes a request on its first day, as long as the mini is free by then.
          </p>
          {[
            ...bookings.mine.map(booking => ({ booking, mine: true })),
            ...bookings.onMyMinis.map(booking => ({ booking, mine: false })),
          ].map(({ booking, mine }) => (
            <div key={booking.id} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{booking.miniName}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {bookingSpan(booking)}
                  {' · '}
                  {mine ? `from ${booking.ownerName}` : `booked by ${booking.holderName}`}
                  {booking.note ? ` · ${booking.note}` : ''}
                  {booking.started ? ' · now a request' : ''}
                </div>
              </div>
              {!booking.started && (
                <button
                  type="button"
                  className="btn-secondary"
                  aria-label={`Cancel the booking on ${booking.miniName}`}
                  onClick={() => void cancelBooking(booking.id)}
                  style={{ padding: '6px 12px', fontSize: '13px' }}
                >
                  Cancel booking
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {holds.watching.length > 0 && (
        <section aria-label="Notify me when a spot opens" style={{ marginBottom: '28px' }}>
          <h3 style={{ fontSize: '17px', color: '#c9a84c', marginBottom: '12px' }}>Notify me when a spot opens</h3>
          {holds.watching.map(watch => (
            <div key={watch.miniId} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{watch.miniName}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Line is full ({watch.holdCount} holds)</div>
              </div>
              <button
                type="button"
                className="btn-secondary"
                aria-label={`Stop notifying me about ${watch.miniName}`}
                onClick={() => void holdAction(`/api/holds/minis/${watch.miniId}/watch`)}
                style={{ padding: '6px 12px', fontSize: '13px' }}
              >
                Stop notifying me
              </button>
            </div>
          ))}
        </section>
      )}

      {loading ? (
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      ) : loans.length === 0 && holds.holds.length === 0 && holds.watching.length === 0
        && bookings.mine.length === 0 && bookings.onMyMinis.length === 0 && !error ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
          <p style={{ fontSize: '18px', marginBottom: '8px' }}>No requests or loans yet</p>
          <Link to="/">Browse the collection</Link>
        </div>
      ) : (
        <>
          {renderSide('Borrowing', 'borrower')}
          {renderSide('Lending', 'owner')}
          {history.length > 0 && (
            <section aria-label="History">
              <h3 style={{ fontSize: '17px', color: 'var(--text-muted)', marginBottom: '12px' }}>History</h3>
              {history.map(renderCard)}
              {olderError && <div className="error-msg" style={{ marginBottom: '12px' }}>{olderError}</div>}
              {canShowOlder && (
                <div style={{ textAlign: 'center' }}>
                  <button type="button" className="btn-secondary" onClick={() => void loadOlder()} disabled={loadingOlder}>
                    {loadingOlder ? 'Loading…' : 'Show older'}
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
