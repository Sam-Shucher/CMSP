import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth, useShowPrices } from '../App';
import ConfirmDeleteModal from '../components/ConfirmDeleteModal';
import FieldError from '../components/FieldError';
import { useValidatedForm } from '../hooks/useValidatedForm';
import { validateEmail } from '../utils/validation';

// Shape of a row from GET /api/admin/approved-emails
type ApprovedEmail = {
  id: number;
  email: string;
  added_at: string;
  added_by_username: string | null; // null if the row was inserted directly in MySQL
};

// Shape of a row from GET /api/admin/users
type UserRow = {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
  role: string;       // 'user' | 'admin'
  created_at: string;
};

// Shape of a row from GET /api/admin/archived-minis
type ArchivedMini = {
  id: number;
  name: string;
  formerOwnerId: number;
  formerOwnerName: string;
  daysLeft: number;
};

// Shape of a row from GET /api/admin/audit-log
type AuditLogEntry = {
  id: number;
  action: string;
  actorName: string;
  targetName: string | null;
  details: string;
  createdAt: string;
};

// A restore awaiting confirmation.
type PendingRestore = { miniId: number; miniName: string; newOwnerId: number; newOwnerName: string };

// Shape of a row from GET /api/admin/loan-incidents — a private tally, never
// shown to anyone but admins, and never a ranking (see BACKLOG.md's
// reasoning against public reliability scores).
type LoanIncident = {
  borrowerId: number | null; // null once their account has been deleted (the name is kept)
  borrowerName: string;
  lostCount: number;
  woundedCount: number;
};

// Admin panel — lets admins manage the invite list and user roles.
// Access is gated by the AdminRoute wrapper in App.tsx.
// A pending destructive action awaiting type-to-confirm before it's carried out.
type PendingDelete =
  | { kind: 'email'; id: number; label: string }
  | { kind: 'user'; id: number; label: string };

// What the server hands back after a reset — shown once, then forgotten.
type IssuedPassword = {
  temporaryPassword: string;
  displayName: string;
  phone: string | null;
  expiresInDays: number;
};

export default function AdminPage(): React.ReactElement {
  const { user: currentUser, collections, refreshSession } = useAuth();
  const activeCollectionName = collections.find(c => c.id === currentUser?.collectionId)?.name ?? '';
  const showPrices = useShowPrices();
  const [savingSettings, setSavingSettings] = useState<boolean>(false);
  const [settingsNote, setSettingsNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [emails, setEmails]     = useState<ApprovedEmail[]>([]);
  const [users, setUsers]       = useState<UserRow[]>([]);
  const [archivedMinis, setArchivedMinis] = useState<ArchivedMini[]>([]);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);
  const [loanIncidents, setLoanIncidents] = useState<LoanIncident[]>([]);
  const invite = useValidatedForm({ email: '' }, {
    email: value => (value.trim() ? validateEmail(value).error ?? null : 'Enter the email address to invite.'),
  });
  const [error, setError]       = useState<string>('');
  const [success, setSuccess]   = useState<string>('');
  const [loading, setLoading]   = useState<boolean>(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [pendingReset, setPendingReset] = useState<{ id: number; username: string } | null>(null);
  const [issuedPassword, setIssuedPassword] = useState<IssuedPassword | null>(null);
  const [restoreTargets, setRestoreTargets] = useState<Record<number, string>>({}); // miniId -> selected newOwnerId
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);

  // Fetches the invite list, the user list, archived minis, and the audit log
  // in parallel. Wrapped in useCallback so it can be added to the useEffect
  // dependency array without causing an infinite loop (the function reference
  // stays stable across renders).
  const fetchData = useCallback(async (): Promise<void> => {
    try {
      const [e, u, a, log, incidents] = await Promise.all([
        api<ApprovedEmail[]>('/api/admin/approved-emails'),
        api<UserRow[]>('/api/admin/users'),
        api<ArchivedMini[]>('/api/admin/archived-minis'),
        api<AuditLogEntry[]>('/api/admin/audit-log'),
        api<LoanIncident[]>('/api/admin/loan-incidents'),
      ]);
      setEmails(e);
      setUsers(u);
      setArchivedMinis(a);
      setAuditLog(log);
      setLoanIncidents(incidents);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data');
    }
  }, []); // no dependencies — this function never needs to change

  // Load data on mount
  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Adds a new email to the invite list and refreshes the table
  async function addEmail(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setSuccess('');
    if (!invite.validateAll()) return;
    const newEmail = invite.values.email.trim();
    setLoading(true);
    try {
      await api('/api/admin/approved-emails', { method: 'POST', json: { email: newEmail } });
      invite.reset();
      setSuccess(`${newEmail} added to the invite list`);
      void fetchData(); // refresh the table
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add email');
    } finally {
      setLoading(false);
    }
  }

  // Turns prices on or off for the whole group. The setting lives with the
  // group list in the app's session, so that's reloaded for every page to follow.
  async function changeShowPrices(show: boolean): Promise<void> {
    setSettingsNote(null);
    setSavingSettings(true);
    try {
      await api('/api/admin/settings', { method: 'PATCH', json: { showPrices: show } });
      await refreshSession();
      setSettingsNote({ ok: true, text: `Prices are now ${show ? 'shown' : 'hidden'} in ${activeCollectionName}` });
    } catch (err: unknown) {
      setSettingsNote({ ok: false, text: err instanceof Error ? err.message : 'Failed to change that setting' });
    } finally {
      setSavingSettings(false);
    }
  }

  // Toggles a user between 'user' and 'admin' roles
  async function toggleRole(userId: number, currentRole: string): Promise<void> {
    const newRole: string = currentRole === 'admin' ? 'user' : 'admin';
    if (!confirm(`Change this user's role to ${newRole}?`)) return;
    setError('');
    setSuccess('');
    try {
      await api(`/api/admin/users/${userId}/role`, { method: 'PATCH', json: { role: newRole } });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to change role');
    }
    void fetchData();
  }

  // Sets a temporary password for someone who's locked out, and shows it once.
  async function confirmReset(): Promise<void> {
    if (!pendingReset) return;
    setError('');
    setSuccess('');
    try {
      setIssuedPassword(await api<IssuedPassword>(`/api/admin/users/${pendingReset.id}/reset-password`, { method: 'POST' }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reset that password');
    }
    setPendingReset(null);
  }

  // Carries out whatever destructive action is pending, once the modal
  // confirms the typed phrase matched.
  async function confirmPendingDelete(): Promise<void> {
    if (!pendingDelete) return;
    setError('');
    setSuccess('');
    try {
      if (pendingDelete.kind === 'email') {
        await api(`/api/admin/approved-emails/${pendingDelete.id}`, { method: 'DELETE' });
      } else {
        // The server says what else went with them (their minis, their account).
        const result = await api<{ message?: string }>(`/api/admin/users/${pendingDelete.id}`, { method: 'DELETE' });
        if (result.message) setSuccess(result.message);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove');
    }
    setPendingDelete(null);
    void fetchData();
  }

  // Gives an archived mini back to a current member, once the modal confirms.
  async function confirmRestore(): Promise<void> {
    if (!pendingRestore) return;
    setError('');
    setSuccess('');
    try {
      const result = await api<{ message?: string }>(
        `/api/admin/archived-minis/${pendingRestore.miniId}/restore`,
        { method: 'POST', json: { newOwnerId: pendingRestore.newOwnerId } }
      );
      if (result.message) setSuccess(result.message);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to restore');
    }
    setPendingRestore(null);
    void fetchData();
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '860px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '4px' }}>Admin Panel</h2>
      <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '24px' }}>
        Managing <strong style={{ color: '#e8e0d0' }}>{activeCollectionName}</strong> — switch groups to administer a different one.
      </p>

      {/* ------------------------------------------------------------------ */}
      {/* Group settings — how this group's pages behave for everyone in it  */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h3 style={sectionHeadStyle}>Group Settings</h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '14px', color: '#e8e0d0', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showPrices}
            disabled={savingSettings}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => void changeShowPrices(e.target.checked)}
          />
          Show prices
        </label>
        <p style={{ fontSize: '13px', color: '#8a7d6a', marginTop: '6px' }}>
          Off hides prices everywhere in {activeCollectionName} — on every mini, in the add and edit forms, and in
          sorting. Prices already entered are kept, and come back if you turn this on again.
        </p>
        {settingsNote && (
          <div className={settingsNote.ok ? 'success-msg' : 'error-msg'} style={{ marginTop: '12px' }}>{settingsNote.text}</div>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Invite list — who is allowed to create an account                   */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h3 style={sectionHeadStyle}>Invite List</h3>
        <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '16px' }}>
          Only emails on this list can create an account.
        </p>

        {/* Add email form */}
        {/* noValidate: no browser popup — our own message shows under the box */}
        <form onSubmit={addEmail} noValidate style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              {...invite.field('email', 'invite-email')}
              type="email"
              aria-label="Email to invite"
              placeholder="friend@example.com"
              required
              style={{ flex: 1 }}
            />
            <button className="btn-primary" type="submit" disabled={loading} style={{ whiteSpace: 'nowrap' }}>
              {loading ? 'Adding…' : 'Add Email'}
            </button>
          </div>
          <FieldError id="invite-email" message={invite.errorFor('email')} />
        </form>

        {error   && <div className="error-msg"   style={{ marginBottom: '12px' }}>{error}</div>}
        {success && <div className="success-msg" style={{ marginBottom: '12px' }}>{success}</div>}

        {/* Approved emails table */}
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Added by</th>
              <th style={thStyle}>Date</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {emails.map((e: ApprovedEmail) => (
              <tr key={e.id} style={{ borderBottom: '1px solid #3d3629' }}>
                <td style={tdStyle}>{e.email}</td>
                <td style={tdStyle}>{e.added_by_username ?? '—'}</td>
                <td style={tdStyle}>{new Date(e.added_at).toLocaleDateString()}</td>
                <td style={tdStyle}>
                  <button
                    className="btn-danger"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                    onClick={() => setPendingDelete({ kind: 'email', id: e.id, label: e.email })}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {emails.length === 0 && (
              <tr>
                <td colSpan={4} style={{ ...tdStyle, color: '#8a7d6a', textAlign: 'center' }}>
                  No approved emails yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Registered users — manage roles                                      */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h3 style={sectionHeadStyle}>Members of {activeCollectionName}</h3>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Username</th>
              <th style={thStyle}>Display Name</th>
              <th style={thStyle}>Email</th>
              <th style={thStyle}>Phone</th>
              <th style={thStyle}>Neighborhood</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>Joined</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u: UserRow) => (
              <tr key={u.id} style={{ borderBottom: '1px solid #3d3629' }}>
                <td style={tdStyle}>{u.username}</td>
                <td style={tdStyle}>{u.display_name}</td>
                <td style={tdStyle}>{u.email}</td>
                <td style={tdStyle}>{u.phone ?? '—'}</td>
                <td style={tdStyle}>{u.neighborhood ?? '—'}</td>
                <td style={tdStyle}>
                  {/* Role in THIS group — admins get a green badge, members a grey tag */}
                  <span className={u.role === 'admin' ? 'badge-available' : 'tag'}>{u.role === 'admin' ? 'Admin' : 'Member'}</span>
                </td>
                <td style={tdStyle}>{new Date(u.created_at).toLocaleDateString()}</td>
                <td style={tdStyle}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {/* Never offer to change your own role or remove yourself — the server blocks both too, but hiding them avoids a confusing error */}
                    {u.id !== currentUser?.userId && (
                      <button
                        className="btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '12px' }}
                        onClick={() => void toggleRole(u.id, u.role)}
                      >
                        {u.role === 'admin' ? 'Demote' : 'Make Admin'}
                      </button>
                    )}
                    {/* For someone locked out: hand them a temporary password in person */}
                    {u.id !== currentUser?.userId && (
                      <button
                        className="btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '12px' }}
                        onClick={() => setPendingReset({ id: u.id, username: u.username })}
                      >
                        Reset password
                      </button>
                    )}
                    {u.id !== currentUser?.userId && (
                      <button
                        className="btn-danger"
                        style={{ padding: '4px 10px', fontSize: '12px' }}
                        onClick={() => setPendingDelete({ kind: 'user', id: u.id, label: u.username })}
                      >
                        Remove from Group
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Archived minis — left behind by a removed member who kept another  */}
      {/* group; restorable until maintenance/housekeeping.ts purges them.   */}
      {/* ------------------------------------------------------------------ */}
      {archivedMinis.length > 0 && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadStyle}>Archived Minis</h3>
          <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '16px' }}>
            Left behind when their owner was removed from {activeCollectionName}. Give one to a current member before it's deleted for good.
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Mini</th>
                <th style={thStyle}>Formerly owned by</th>
                <th style={thStyle}>Deleted in</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {archivedMinis.map((mini: ArchivedMini) => (
                <tr key={mini.id} style={{ borderBottom: '1px solid #3d3629' }}>
                  <td style={tdStyle}>{mini.name}</td>
                  <td style={tdStyle}>{mini.formerOwnerName}</td>
                  <td style={tdStyle}>{mini.daysLeft} day{mini.daysLeft === 1 ? '' : 's'}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <select
                        aria-label={`Give ${mini.name} to`}
                        value={restoreTargets[mini.id] ?? ''}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                          setRestoreTargets(prev => ({ ...prev, [mini.id]: e.target.value }))
                        }
                      >
                        <option value="">Choose a member…</option>
                        {users.map((u: UserRow) => (
                          <option key={u.id} value={u.id}>{u.display_name}</option>
                        ))}
                      </select>
                      <button
                        className="btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '12px' }}
                        disabled={!restoreTargets[mini.id]}
                        onClick={() => {
                          const newOwnerId = Number(restoreTargets[mini.id]);
                          const newOwnerName = users.find(u => u.id === newOwnerId)?.display_name ?? '';
                          setPendingRestore({ miniId: mini.id, miniName: mini.name, newOwnerId, newOwnerName });
                        }}
                      >
                        Restore
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Audit log — who removed whom, and what happened to their minis     */}
      {/* ------------------------------------------------------------------ */}
      {auditLog.length > 0 && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadStyle}>Audit Log</h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {auditLog.map((entry: AuditLogEntry) => (
              <li key={entry.id} style={{ fontSize: '13px', color: '#e8e0d0', paddingBottom: '10px', borderBottom: '1px solid #3d3629' }}>
                <div>{entry.details}</div>
                <div style={{ fontSize: '11px', color: '#8a7d6a', marginTop: '2px' }}>{new Date(entry.createdAt).toLocaleString()}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Lost & damaged — a private tally, so a pattern is visible to admins */}
      {/* without being a public reliability score (see BACKLOG.md).         */}
      {/* ------------------------------------------------------------------ */}
      {loanIncidents.length > 0 && (
        <section style={sectionStyle}>
          <h3 style={sectionHeadStyle}>Lost &amp; Damaged</h3>
          <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '16px' }}>
            Visible only to admins — not a ranking, just a way to notice a pattern.
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Borrower</th>
                <th style={thStyle}>Lost</th>
                <th style={thStyle}>Critically Wounded</th>
              </tr>
            </thead>
            <tbody>
              {loanIncidents.map((incident: LoanIncident) => (
                <tr key={incident.borrowerId ?? `removed:${incident.borrowerName}`} style={{ borderBottom: '1px solid #3d3629' }}>
                  <td style={tdStyle}>
                    {incident.borrowerName}
                    {incident.borrowerId === null && <span style={{ color: '#8a7d6a' }}> (no longer a member)</span>}
                  </td>
                  <td style={tdStyle}>{incident.lostCount}</td>
                  <td style={tdStyle}>{incident.woundedCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {pendingReset && (
        <ConfirmDeleteModal
          title="Reset password"
          description={`This signs ${pendingReset.username} out everywhere and gives you a temporary password to pass on. They'll choose their own when they next sign in.`}
          confirmPhrase={pendingReset.username}
          confirmButtonLabel="Reset password"
          onConfirm={() => void confirmReset()}
          onCancel={() => setPendingReset(null)}
        />
      )}

      {/* Shown once, right after a reset — the only time this password is readable */}
      {issuedPassword && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#252219', border: '1px solid #3d3629', borderRadius: '10px', padding: '28px', width: '100%', maxWidth: '440px' }}>
            <h3 style={{ fontSize: '17px', color: '#c9a84c', marginBottom: '10px' }}>
              Temporary password for {issuedPassword.displayName}
            </h3>
            <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '16px' }}>
              This is the only time it's shown. Text or tell it to them
              {issuedPassword.phone ? ` on ${issuedPassword.phone}` : ' (no phone number on file)'} — it works for the
              next {issuedPassword.expiresInDays} days, and the app asks them to choose their own when they sign in.
            </p>
            <p data-testid="temporary-password" style={{
              fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: '20px', letterSpacing: '0.04em',
              color: '#e8e0d0', background: '#1c1a17', border: '1px solid #3d3629', borderRadius: '6px',
              padding: '14px', textAlign: 'center', marginBottom: '18px', userSelect: 'all',
            }}>
              {issuedPassword.temporaryPassword}
            </p>
            <button className="btn-primary" style={{ width: '100%', padding: '10px' }} onClick={() => setIssuedPassword(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDeleteModal
          title={pendingDelete.kind === 'email' ? 'Remove email' : 'Remove member'}
          description={
            pendingDelete.kind === 'email'
              ? 'This removes the email from the invite list. It will not affect an account that already registered with it.'
              : `This removes them from ${activeCollectionName}. If they belong to another group, their minis here are archived — restorable from below for 30 days before they're deleted for good. If this is their only group, their whole account and minis are deleted immediately instead. This cannot be undone.`
          }
          confirmPhrase={pendingDelete.label}
          confirmButtonLabel={pendingDelete.kind === 'email' ? 'Delete' : 'Confirm Delete'}
          onConfirm={() => void confirmPendingDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingRestore && (
        <ConfirmDeleteModal
          title="Restore mini"
          description={`This gives ${pendingRestore.miniName} to ${pendingRestore.newOwnerName}.`}
          confirmPhrase={pendingRestore.newOwnerName}
          confirmButtonLabel="Confirm Restore"
          onConfirm={() => void confirmRestore()}
          onCancel={() => setPendingRestore(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const sectionStyle: React.CSSProperties = {
  background: '#252219',
  border: '1px solid #3d3629',
  borderRadius: '8px',
  padding: '24px',
  marginBottom: '24px',
};

const sectionHeadStyle: React.CSSProperties = {
  fontSize: '16px',
  color: '#c9a84c',
  marginBottom: '12px',
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '14px',
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: '11px',
  color: '#8a7d6a',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  borderBottom: '1px solid #3d3629',
};

const tdStyle: React.CSSProperties = {
  padding: '10px',
  verticalAlign: 'middle',
};
