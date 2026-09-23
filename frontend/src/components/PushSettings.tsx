import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { PushStatus, pushStatus, turnOnPush, turnOffPush } from '../push';

const hintStyle: React.CSSProperties = { fontSize: '13px', color: '#8a7d6a', marginBottom: '12px' };

// What to say for each state this device can be in.
const EXPLAIN: Record<Exclude<PushStatus, 'on' | 'off'>, string> = {
  'unsupported': 'This browser can\'t show notifications from the site. On Android, Chrome can; on iPhone, add the site to your home screen from Safari.',
  'needs-install': 'On iPhone and iPad, notifications only work from the home-screen app: in Safari tap Share, then "Add to Home Screen", and open Mini Library from there.',
  'not-set-up': 'Phone notifications aren\'t set up on the server yet — ask whoever runs the site.',
  'blocked': 'Notifications are blocked for this site. Allow them in your browser\'s site settings (on the home-screen app: the phone\'s Settings → Notifications), then come back here.',
};

// On the Profile page: phone notifications, for this device only. Everything
// the bell gets shows up on the lock screen too.
export default function PushSettings(): React.ReactElement {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [note, setNote] = useState<string>('');

  async function refresh(): Promise<void> {
    try {
      setStatus(await pushStatus());
    } catch {
      setStatus('off');
    }
  }

  useEffect(() => {
    pushStatus().then(setStatus, () => setStatus('off'));
  }, []);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'That didn\'t work — try again.');
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  async function sendTest(): Promise<void> {
    const { sent } = await api<{ sent: number }>('/api/push/test', { method: 'POST' });
    setNote(sent > 0
      ? 'Sent — it should appear in a moment.'
      : 'Nothing could be delivered. Try turning notifications off and on again.');
  }

  return (
    <div style={{ marginTop: '32px', paddingTop: '20px', borderTop: '1px solid #3d3629' }}>
      <h3 style={{ fontSize: '15px', color: '#c9a84c', marginBottom: '6px' }}>Phone notifications</h3>
      {error && <div className="error-msg" style={{ marginBottom: '12px' }}>{error}</div>}
      {note && <div className="success-msg" role="status" style={{ marginBottom: '12px' }}>{note}</div>}

      {status === null && <p style={hintStyle}>Checking…</p>}

      {status === 'off' && (
        <>
          <p style={hintStyle}>
            Get loan requests, messages, and reminders on this device, even when the site isn't open.
          </p>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(turnOnPush)}>
            {busy ? 'Turning on…' : 'Turn on for this device'}
          </button>
        </>
      )}

      {status === 'on' && (
        <>
          <p style={hintStyle}>On for this device. Signing out here pauses them until you sign back in.</p>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(sendTest)}>
              Send a test
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(turnOffPush)}>
              Turn off
            </button>
          </div>
        </>
      )}

      {status !== null && status !== 'on' && status !== 'off' && <p style={hintStyle}>{EXPLAIN[status]}</p>}
    </div>
  );
}
