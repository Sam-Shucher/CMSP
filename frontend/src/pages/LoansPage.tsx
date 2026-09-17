import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, Loan, MyHolds } from '../api/client';
import LoanCard from '../components/LoanCard';

// How often the "time left" countdowns re-render.
const TICK_MS = 60 * 1000;

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px', marginBottom: '8px',
  background: '#252219', border: '1px solid #3d3629', borderRadius: '8px',
};

// Everything you're borrowing or lending in this collection. Each mini is
// its own request, grouped by the person on the other side of the desk.
export default function LoansPage(): React.ReactElement {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [now, setNow] = useState<Date>(new Date());

  const [holds, setHolds] = useState<MyHolds>({ holds: [], watching: [] });
  const [holdError, setHoldError] = useState<string>('');

  const loadLoans = useCallback(async (): Promise<void> => {
    try {
      setLoans(await api<Loan[]>('/api/loans'));
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

  useEffect(() => {
    void loadLoans();
    void loadHolds();
  }, [loadLoans, loadHolds]);

  async function holdAction(path: string): Promise<void> {
    setHoldError('');
    try {
      await api(path, { method: 'DELETE' });
    } catch (err: unknown) {
      setHoldError(err instanceof Error ? err.message : 'Something went wrong');
    }
    await loadHolds();
  }

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const active = loans.filter((l: Loan) => l.status === 'negotiating' || l.status === 'adventuring');
  const history = loans.filter((l: Loan) => l.status === 'returned' || l.status === 'cancelled');

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

    const byPerson = new Map<number, { name: string; loans: Loan[] }>();
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
            key={personId}
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
          <p style={{ fontSize: '12px', color: '#8a7d6a', marginBottom: '12px' }}>
            When a mini comes back, the first person in line is checked out automatically — you'll get a notification.
          </p>
          {holds.holds.map(hold => (
            <div key={hold.miniId} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{hold.miniName}</div>
                <div style={{ fontSize: '12px', color: '#8a7d6a' }}>
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

      {holds.watching.length > 0 && (
        <section aria-label="Notify me when a spot opens" style={{ marginBottom: '28px' }}>
          <h3 style={{ fontSize: '17px', color: '#c9a84c', marginBottom: '12px' }}>Notify me when a spot opens</h3>
          {holds.watching.map(watch => (
            <div key={watch.miniId} style={rowStyle}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{watch.miniName}</div>
                <div style={{ fontSize: '12px', color: '#8a7d6a' }}>Line is full ({watch.holdCount} holds)</div>
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
        <p style={{ color: '#8a7d6a' }}>Loading…</p>
      ) : loans.length === 0 && holds.holds.length === 0 && holds.watching.length === 0 && !error ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#8a7d6a' }}>
          <p style={{ fontSize: '18px', marginBottom: '8px' }}>No requests or loans yet</p>
          <Link to="/">Browse the collection</Link>
        </div>
      ) : (
        <>
          {renderSide('Borrowing', 'borrower')}
          {renderSide('Lending', 'owner')}
          {history.length > 0 && (
            <section aria-label="History">
              <h3 style={{ fontSize: '17px', color: '#8a7d6a', marginBottom: '12px' }}>History</h3>
              {history.map(renderCard)}
            </section>
          )}
        </>
      )}
    </div>
  );
}
