import React, { useEffect, useState } from 'react';
import { api, Loan, LoanStage } from '../api/client';
import { formatTimeRemaining, fromDateTimeLocalValue, toDateTimeLocalValue } from '../utils/loanTime';

const MAX_DURATION_DAYS = 365;

const STAGE_LABELS: Record<LoanStage, string> = {
  negotiating: 'Negotiating',
  agreed: 'Agreed',
  adventuring: 'Adventuring',
  overdue: 'Overdue',
  returned: 'Returned',
  cancelled: 'Cancelled',
};

const STAGE_COLORS: Record<LoanStage, string> = {
  negotiating: '#c9a84c',
  agreed: '#27ae60',
  adventuring: '#5dade2',
  overdue: '#e74c3c',
  returned: '#8a7d6a',
  cancelled: '#8a7d6a',
};

type LoanCardProps = {
  loan: Loan;
  now: Date;
  // How many other open requests share this loan's borrower and owner —
  // "apply to all" only makes sense when there's at least one.
  otherOpenRequests: number;
  onUpdated: () => void;
};

// One mini's request/loan, seen from the viewer's side. While negotiating,
// both sides can propose when/where/how (only the owner sets the duration),
// and it takes both keys turned before the owner can confirm the handoff.
export default function LoanCard({ loan, now, otherOpenRequests, onUpdated }: LoanCardProps): React.ReactElement {
  const [when, setWhen] = useState<string>(toDateTimeLocalValue(loan.handoffWhen));
  const [where, setWhere] = useState<string>(loan.handoffWhere ?? '');
  const [how, setHow] = useState<string>(loan.handoffHow ?? '');
  const [duration, setDuration] = useState<string>(loan.durationDays?.toString() ?? '');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [confirmingCancel, setConfirmingCancel] = useState<boolean>(false);

  // Re-sync the form when this loan's saved terms change (after either side
  // proposes), without wiping unsaved edits whenever some other card reloads.
  useEffect(() => {
    setWhen(toDateTimeLocalValue(loan.handoffWhen));
    setWhere(loan.handoffWhere ?? '');
    setHow(loan.handoffHow ?? '');
    setDuration(loan.durationDays?.toString() ?? '');
  }, [loan.handoffWhen, loan.handoffWhere, loan.handoffHow, loan.durationDays]);

  const isOwner = loan.role === 'owner';
  const them = loan.counterpart.displayName;
  const negotiating = loan.status === 'negotiating';
  const adventuring = loan.status === 'adventuring';
  const myKey = isOwner ? loan.ownerApproved : loan.borrowerApproved;
  const theirKey = isOwner ? loan.borrowerApproved : loan.ownerApproved;
  const termsComplete = Boolean(loan.handoffWhen && loan.handoffWhere && loan.handoffHow && loan.durationDays);
  const overdue = adventuring && loan.dueAt !== null && new Date(loan.dueAt).getTime() < now.getTime();
  const stage: LoanStage = adventuring ? (overdue ? 'overdue' : 'adventuring') : loan.stage;

  // Only send what actually changed — an unchanged field would be a no-op
  // anyway, and blank fields can't clear terms that were already proposed.
  function changedTerms(): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    const whenIso = fromDateTimeLocalValue(when);
    const savedWhen = loan.handoffWhen ? new Date(loan.handoffWhen).getTime() : null;
    if (whenIso && new Date(whenIso).getTime() !== savedWhen) patch.when = whenIso;
    if (where.trim() && where.trim() !== loan.handoffWhere) patch.where = where.trim();
    if (how.trim() && how.trim() !== loan.handoffHow) patch.how = how.trim();
    if (isOwner && duration.trim() && Number(duration) !== loan.durationDays) patch.durationDays = Number(duration);
    return patch;
  }

  const hasChanges = Object.keys(changedTerms()).length > 0;

  // What happens next, from where this person stands. The handoff is the
  // owner's to confirm, in person, once both keys are turned.
  function nextStep(): string {
    if (myKey && theirKey) {
      return isOwner
        ? 'You\'re both agreed. When you meet and hand it over, confirm the handoff.'
        : `Agreed! ${them} will confirm the handoff when you meet.`;
    }
    if (myKey) {
      return isOwner
        ? `Waiting on ${them} to approve. Once they do, you'll confirm the handoff here when you meet.`
        : `Waiting on ${them} to approve.`;
    }
    if (theirKey) return `${them} approved these terms — approve too to agree.`;
    return isOwner
      ? 'Set the duration and agree on when, where, and how — then you both approve.'
      : `Agree on when, where, and how — ${them} sets the duration. Then you both approve.`;
  }

  async function run(path: string, options: RequestInit & { json?: unknown } = { method: 'POST' }): Promise<void> {
    setError('');
    setBusy(true);
    try {
      await api(path, options);
      setConfirmingCancel(false);
      onUpdated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function proposeTerms(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const patch = changedTerms();
    if ('durationDays' in patch) {
      const days = patch.durationDays as number;
      if (!Number.isInteger(days) || days < 1 || days > MAX_DURATION_DAYS) {
        setError(`Duration must be a whole number of days from 1 to ${MAX_DURATION_DAYS}`);
        return;
      }
    }
    await run(`/api/loans/${loan.id}/terms`, { method: 'PATCH', json: patch });
  }

  return (
    <div style={{ background: '#1c1a17', border: '1px solid #3d3629', borderRadius: '8px', padding: '14px', marginBottom: '12px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '10px' }}>
        <div style={{ width: '44px', height: '44px', flexShrink: 0, background: '#252219', borderRadius: '4px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {loan.miniImage
            ? <img src={loan.miniImage} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : <span style={{ opacity: 0.2 }}>⚔</span>}
        </div>
        <div style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>{loan.miniName}</div>
        <span style={{
          color: STAGE_COLORS[stage], border: `1px solid ${STAGE_COLORS[stage]}`, borderRadius: '20px',
          fontSize: '11px', fontWeight: 600, padding: '2px 8px', textTransform: 'uppercase', letterSpacing: '0.05em',
        }}>
          {STAGE_LABELS[stage]}
        </span>
      </div>

      {negotiating && (
        <>
          <form noValidate onSubmit={(e: React.FormEvent) => void proposeTerms(e)} style={{ display: 'grid', gap: '8px', marginBottom: '10px' }}>
            <Field label="When" id={`loan-${loan.id}-when`}>
              <input id={`loan-${loan.id}-when`} type="datetime-local" value={when} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWhen(e.target.value)} />
            </Field>
            <Field label="Where" id={`loan-${loan.id}-where`}>
              <input id={`loan-${loan.id}-where`} type="text" maxLength={255} placeholder="e.g. game night at the shop" value={where} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWhere(e.target.value)} />
            </Field>
            <Field label="How" id={`loan-${loan.id}-how`}>
              <input id={`loan-${loan.id}-how`} type="text" maxLength={255} placeholder="e.g. in person, dropped at the door" value={how} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHow(e.target.value)} />
            </Field>
            {isOwner ? (
              <Field label="Duration (days)" id={`loan-${loan.id}-duration`}>
                <input id={`loan-${loan.id}-duration`} type="number" min={1} max={MAX_DURATION_DAYS} step={1} value={duration} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDuration(e.target.value)} />
              </Field>
            ) : (
              <p style={{ fontSize: '13px', color: '#8a7d6a' }}>
                {loan.durationDays
                  ? `Loan length: ${loan.durationDays} ${loan.durationDays === 1 ? 'day' : 'days'} (set by ${them})`
                  : `${them} hasn't proposed a duration yet.`}
              </p>
            )}
            <button type="submit" className="btn-secondary" disabled={busy || !hasChanges} style={{ justifySelf: 'start', padding: '6px 14px', fontSize: '13px' }}>
              Propose terms
            </button>
          </form>

          {/* The two keys */}
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '13px', marginBottom: '10px' }}>
            <span style={{ color: myKey ? '#27ae60' : '#8a7d6a' }}>🔑 You: {myKey ? 'approved' : 'not yet'}</span>
            <span style={{ color: theirKey ? '#27ae60' : '#8a7d6a' }}>🔑 {them}: {theirKey ? 'approved' : 'not yet'}</span>
          </div>

          <p style={{ fontSize: '13px', color: myKey && theirKey ? '#27ae60' : '#8a7d6a', marginBottom: '10px' }}>
            {nextStep()}
          </p>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
            {!myKey && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !termsComplete || hasChanges}
                title={hasChanges ? 'Propose your changes first' : !termsComplete ? 'When, where, how, and duration all need to be set' : undefined}
                onClick={() => void run(`/api/loans/${loan.id}/approve`)}
                style={{ padding: '6px 14px', fontSize: '13px' }}
              >
                Approve terms
              </button>
            )}
            {myKey && theirKey && isOwner && (
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(`/api/loans/${loan.id}/handoff`)} style={{ padding: '6px 14px', fontSize: '13px' }}>
                Confirm handoff
              </button>
            )}
            {otherOpenRequests > 0 && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void run(`/api/loans/${loan.id}/apply-terms-to-all`)} style={{ padding: '6px 14px', fontSize: '13px' }}>
                Apply these terms to all requests with {them}
              </button>
            )}
          </div>

          <div style={{ marginTop: '10px' }}>
            {confirmingCancel ? (
              <span style={{ display: 'inline-flex', gap: '8px', alignItems: 'center', fontSize: '13px' }}>
                Cancel this request?
                <button type="button" className="btn-danger" disabled={busy} onClick={() => void run(`/api/loans/${loan.id}/cancel`)} style={{ padding: '4px 10px', fontSize: '12px' }}>
                  Yes, cancel
                </button>
                <button type="button" className="btn-secondary" onClick={() => setConfirmingCancel(false)} style={{ padding: '4px 10px', fontSize: '12px' }}>
                  Keep it
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmingCancel(true)} style={{ background: 'none', color: '#8a7d6a', padding: 0, fontSize: '12px', textDecoration: 'underline' }}>
                Cancel request
              </button>
            )}
          </div>
        </>
      )}

      {adventuring && loan.dueAt && (
        <div style={{ fontSize: '13px' }}>
          <p style={{ color: overdue ? '#e74c3c' : '#5dade2', fontWeight: 600 }}>
            {formatTimeRemaining(loan.dueAt, now)}
          </p>
          <p style={{ color: '#8a7d6a' }}>
            {isOwner ? `With ${them}` : `Borrowed from ${them}`} · due {new Date(loan.dueAt).toLocaleString()}
          </p>
          {/* The borrower's side of the handoff record. The loan already started when the owner confirmed. */}
          {loan.receivedAt ? (
            <p style={{ color: '#27ae60', marginTop: '6px' }}>
              {isOwner ? `✓ ${them} confirmed they got it` : '✓ You confirmed you got it'}
            </p>
          ) : isOwner ? (
            <p style={{ color: '#8a7d6a', marginTop: '6px' }}>{them} hasn't confirmed they got it yet.</p>
          ) : (
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
              <span style={{ color: '#8a7d6a' }}>Have it? Let {them} know you got it.</span>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(`/api/loans/${loan.id}/received`)} style={{ padding: '6px 14px', fontSize: '13px' }}>
                Got it
              </button>
            </div>
          )}
          {isOwner && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(`/api/loans/${loan.id}/return`)} style={{ marginTop: '8px', padding: '6px 14px', fontSize: '13px' }}>
              Mark returned
            </button>
          )}
        </div>
      )}

      {loan.status === 'returned' && loan.returnedAt && (
        <p style={{ fontSize: '13px', color: '#8a7d6a' }}>Back home since {new Date(loan.returnedAt).toLocaleDateString()}</p>
      )}

      {error && <div className="error-msg" style={{ marginTop: '10px' }}>{error}</div>}
    </div>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', alignItems: 'center', gap: '8px' }}>
      <label htmlFor={id} style={{ fontSize: '13px', color: '#8a7d6a' }}>{label}</label>
      {children}
    </div>
  );
}
