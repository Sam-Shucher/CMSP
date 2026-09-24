import React, { useCallback, useEffect, useState } from 'react';
import { api, HoldSummary, MiniStatus } from '../api/client';

type HoldPanelProps = {
  miniId: number;
  status: MiniStatus;
  isOwn: boolean;
};

// The hold line for a mini that isn't available. Members can get in line (up
// to 3) or, when it's full, ask to be told when a spot opens. The owner sees
// who's waiting, in order. Nobody in line negotiates while the mini is out —
// when it's confirmed back, the first person is checked out automatically.
export default function HoldPanel({ miniId, status, isOwn }: HoldPanelProps): React.ReactElement | null {
  const [summary, setSummary] = useState<HoldSummary | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  const load = useCallback(async (): Promise<void> => {
    try {
      setSummary(await api<HoldSummary>(`/api/holds/minis/${miniId}`));
    } catch {
      setSummary(null); // not essential — the rest of the view still works
    }
  }, [miniId]);

  useEffect(() => {
    if (status !== 'available') void load();
  }, [load, status]);

  if (status === 'available' || !summary) return null;

  async function run(path: string, method: 'POST' | 'DELETE'): Promise<void> {
    setError('');
    setBusy(true);
    try {
      await api(path, { method });
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const base = `/api/holds/minis/${miniId}`;
  const full = summary.count >= summary.max;

  if (isOwn) {
    const queue = summary.queue ?? [];
    return (
      <div style={panelStyle}>
        {queue.length === 0 ? (
          <p style={mutedStyle}>Nobody is waiting in line for this mini.</p>
        ) : (
          <>
            <p style={mutedStyle}>Waiting in line ({queue.length} of {summary.max}):</p>
            <ol aria-label="Waiting in line" style={{ margin: '6px 0 0', paddingLeft: 0, listStyle: 'none', fontSize: '13px' }}>
              {queue.map(entry => (
                <li key={entry.position}>{entry.position}. {entry.displayName}</li>
              ))}
            </ol>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={panelStyle}>
      <p style={mutedStyle}>
        {summary.count} of {summary.max} holds. When it's back, the first person in line is checked out automatically.
      </p>

      <div style={{ marginTop: '10px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        {summary.position !== null ? (
          <>
            <span style={{ fontSize: '14px', color: '#c9a84c', fontWeight: 600 }}>You're #{summary.position} in line</span>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(base, 'DELETE')} style={smallButton}>
              Leave the line
            </button>
          </>
        ) : !full ? (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(base, 'POST')} style={smallButton}>
            Place a hold
          </button>
        ) : summary.watching ? (
          <>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>The line is full. We'll let you know when a spot opens.</span>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(`${base}/watch`, 'DELETE')} style={smallButton}>
              Stop notifying me
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>The line is full.</span>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(`${base}/watch`, 'POST')} style={smallButton}>
              Notify me when a spot opens
            </button>
          </>
        )}
      </div>

      {error && <div className="error-msg" style={{ marginTop: '10px' }}>{error}</div>}
    </div>
  );
}

const panelStyle: React.CSSProperties = { marginTop: '12px' };
const mutedStyle: React.CSSProperties = { fontSize: '13px', color: 'var(--text-muted)' };
const smallButton: React.CSSProperties = { padding: '6px 14px', fontSize: '13px' };
