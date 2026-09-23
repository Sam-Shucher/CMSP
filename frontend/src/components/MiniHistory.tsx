import React, { useState } from 'react';
import { api, MiniHistoryEntry } from '../api/client';

// "Who's had this, how often" — a mini's own owner (or an admin) can expand
// this to see every loan that actually happened. Collapsed by default and
// fetched only on request: most visits to the edit page don't need it, and
// this app otherwise keeps a mini's CURRENT borrower anonymous to everyone but
// the two people in the loan, so a full history isn't something to show
// unasked either.
export default function MiniHistory({ miniId }: { miniId: number }): React.ReactElement {
  const [open, setOpen] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  // null = never fetched yet; distinguishes "not loaded" from "loaded, empty".
  const [history, setHistory] = useState<MiniHistoryEntry[] | null>(null);

  async function reveal(): Promise<void> {
    setOpen(true);
    if (history !== null) return; // already have it — closing and reopening shouldn't re-fetch
    setLoading(true);
    setError('');
    try {
      setHistory(await api<MiniHistoryEntry[]>(`/api/minis/${miniId}/history`));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: '24px', paddingTop: '20px', borderTop: '1px solid #3d3629' }}>
      <button
        type="button"
        className="btn-secondary"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void reveal())}
      >
        {open ? 'Hide lending history' : 'View lending history'}
      </button>

      {open && (
        <div style={{ marginTop: '12px' }}>
          {loading && <p style={{ color: '#8a7d6a', fontSize: '13px' }}>Loading…</p>}
          {error && <div className="error-msg" style={{ fontSize: '13px' }}>{error}</div>}

          {history?.length === 0 && (
            <p style={{ color: '#8a7d6a', fontSize: '13px' }}>Nobody's borrowed this one yet.</p>
          )}

          {history && history.length > 0 && (
            <>
              <p style={{ color: '#8a7d6a', fontSize: '13px', marginBottom: '10px' }}>
                Lent out {history.length} time{history.length === 1 ? '' : 's'}.
              </p>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {history.map((entry: MiniHistoryEntry) => (
                  <li
                    key={entry.loanId}
                    style={{ fontSize: '13px', color: '#e8e0d0', paddingBottom: '8px', borderBottom: '1px solid #3d3629' }}
                  >
                    <strong>{entry.borrowerName}</strong>
                    {' — '}
                    {entry.ongoing ? (
                      <span>
                        since {new Date(entry.handedOffAt).toLocaleDateString()} (still out, {entry.daysOut} day{entry.daysOut === 1 ? '' : 's'} so far)
                      </span>
                    ) : entry.outcome === 'lost' ? (
                      <span style={{ color: '#e74c3c' }}>
                        since {new Date(entry.handedOffAt).toLocaleDateString()} — never came back (lost)
                      </span>
                    ) : entry.outcome === 'critically_wounded' ? (
                      <span style={{ color: '#e74c3c' }}>
                        {new Date(entry.handedOffAt).toLocaleDateString()} to {entry.returnedAt ? new Date(entry.returnedAt).toLocaleDateString() : '—'} — came back critically wounded ({entry.daysOut} day{entry.daysOut === 1 ? '' : 's'})
                      </span>
                    ) : (
                      <span>
                        {new Date(entry.handedOffAt).toLocaleDateString()} to {entry.returnedAt ? new Date(entry.returnedAt).toLocaleDateString() : '—'} ({entry.daysOut} day{entry.daysOut === 1 ? '' : 's'})
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
