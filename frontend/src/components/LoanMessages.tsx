import React, { useEffect, useState } from 'react';
import { api, LoanMessage } from '../api/client';
import { looksBlank } from '../utils/validation';
import { LIMITS } from '../limits';

// A loan's message thread — "running 20 minutes late", "front door, ring
// twice" — said here rather than by text, so what was agreed stays with the
// loan. Only the loan's two people can see it. Open while the loan is active;
// once it's over the thread is kept, read-only, as a record.
//
// Shut by default, like the condition notes: a page of loan cards shouldn't
// fetch a thread per card. The card's count (from GET /api/loans) says when
// there's something new, and the Loans page re-checks that every 30 seconds —
// so an open thread reloads when that count grows, with no poller of its own.

type LoanMessagesProps = {
  loanId: number;
  counterpartName: string;
  messageCount: number;
  unreadMessages: number;
  canPost: boolean;
  onChanged: () => void;
};

function sentAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function LoanMessages({
  loanId, counterpartName, messageCount, unreadMessages, canPost, onChanged,
}: LoanMessagesProps): React.ReactElement | null {
  const [open, setOpen] = useState<boolean>(false);
  const [thread, setThread] = useState<LoanMessage[]>([]);
  // The thread length last loaded (or sent) — a bigger count on the loan
  // than this means the other person has said something since.
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  useEffect(() => {
    if (!open || (loadedFor !== null && loadedFor >= messageCount)) return;
    setLoadedFor(messageCount);
    void (async () => {
      try {
        const loaded = await api<LoanMessage[]>(`/api/loans/${loanId}/messages`);
        setThread(loaded);
        setError('');
        // Seen now: they get their "Seen", and the card's "new" goes away.
        if (loaded.some(message => !message.mine && !message.read)) {
          await api(`/api/loans/${loanId}/messages/read`, { method: 'POST' });
          onChanged();
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Could not load the messages');
      }
    })();
  }, [open, messageCount, loadedFor, loanId, onChanged]);

  async function send(): Promise<void> {
    if (looksBlank(draft) || busy) return;
    setError('');
    setBusy(true);
    try {
      const updated = await api<LoanMessage[]>(`/api/loans/${loanId}/messages`, { method: 'POST', json: { body: draft.trim() } });
      setThread(updated);
      setLoadedFor(updated.length);
      setDraft('');
      onChanged();
    } catch (err: unknown) {
      // The draft stays put, so nothing typed is lost to a refusal.
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function close(): void {
    setOpen(false);
    setLoadedFor(null); // opening again always shows the latest
  }

  // A finished loan nobody wrote on has nothing to show and nothing to offer.
  if (!canPost && messageCount === 0) return null;

  if (!open) {
    const label = messageCount === 0
      ? `Message ${counterpartName}`
      : `Messages (${messageCount})${unreadMessages > 0 ? ` · ${unreadMessages} new` : ''}`;
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          background: 'none', padding: 0, fontSize: '12px', textDecoration: 'underline', marginTop: '8px', marginRight: '14px',
          color: unreadMessages > 0 ? '#c9a84c' : 'var(--text-muted)', fontWeight: unreadMessages > 0 ? 600 : 400,
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div style={{ marginTop: '10px', borderTop: '1px solid #3d3629', paddingTop: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', color: '#c9a84c', fontWeight: 600 }}>Messages with {counterpartName}</span>
        <button
          type="button"
          onClick={close}
          style={{ background: 'none', color: 'var(--text-muted)', padding: 0, fontSize: '12px', textDecoration: 'underline' }}
        >
          Hide
        </button>
      </div>

      {thread.length > 0 ? (
        <ul aria-label={`Messages with ${counterpartName}`} style={{ listStyle: 'none', display: 'grid', gap: '8px', marginBottom: '10px' }}>
          {thread.map(message => (
            <li
              key={message.id}
              style={{
                justifySelf: message.mine ? 'end' : 'start', maxWidth: '85%',
                background: message.mine ? '#2e2a1f' : '#252219', border: '1px solid #3d3629', borderRadius: '8px', padding: '8px 10px',
              }}
            >
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                {message.mine ? 'You' : message.authorName} · {sentAt(message.createdAt)}
                {message.mine && message.read && ' · Seen'}
              </div>
              <p style={{ fontSize: '13px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.body}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '10px' }}>
          No messages yet — handy for "running late" or "which door?".
        </p>
      )}

      {canPost ? (
        <form
          noValidate
          onSubmit={(e: React.FormEvent) => { e.preventDefault(); void send(); }}
          style={{ display: 'grid', gap: '6px' }}
        >
          <label htmlFor={`loan-${loanId}-message`} style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Message</label>
          <textarea
            id={`loan-${loanId}-message`}
            rows={2}
            maxLength={LIMITS.loanMessage}
            placeholder={`Say something to ${counterpartName}`}
            value={draft}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
            onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
              // Enter sends, like any chat; Shift+Enter is a new line.
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            style={{ resize: 'vertical' }}
          />
          <button
            type="submit"
            className="btn-secondary"
            disabled={busy || looksBlank(draft)}
            style={{ justifySelf: 'start', padding: '6px 14px', fontSize: '13px' }}
          >
            Send
          </button>
        </form>
      ) : (
        <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          This loan is over, so the thread is closed — its messages are kept as a record.
        </p>
      )}

      {error && <div className="error-msg" style={{ marginTop: '8px' }}>{error}</div>}
    </div>
  );
}
