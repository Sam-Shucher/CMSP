import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../App';
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

// Admin panel — lets admins manage the invite list and user roles.
// Access is gated by the AdminRoute wrapper in App.tsx.
// A pending destructive action awaiting type-to-confirm before it's carried out.
type PendingDelete =
  | { kind: 'email'; id: number; label: string }
  | { kind: 'user'; id: number; label: string };

export default function AdminPage(): React.ReactElement {
  const { user: currentUser, collections } = useAuth();
  const activeCollectionName = collections.find(c => c.id === currentUser?.collectionId)?.name ?? '';
  const [emails, setEmails]     = useState<ApprovedEmail[]>([]);
  const [users, setUsers]       = useState<UserRow[]>([]);
  const invite = useValidatedForm({ email: '' }, {
    email: value => (value.trim() ? validateEmail(value).error ?? null : 'Enter the email address to invite.'),
  });
  const [error, setError]       = useState<string>('');
  const [success, setSuccess]   = useState<string>('');
  const [loading, setLoading]   = useState<boolean>(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  // Fetches both the invite list and the user list in parallel.
  // Wrapped in useCallback so it can be added to the useEffect dependency array without
  // causing an infinite loop (the function reference stays stable across renders).
  const fetchData = useCallback(async (): Promise<void> => {
    try {
      const [e, u] = await Promise.all([
        api<ApprovedEmail[]>('/api/admin/approved-emails'),
        api<UserRow[]>('/api/admin/users'),
      ]);
      setEmails(e);
      setUsers(u);
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

  return (
    <div style={{ padding: '28px 32px', maxWidth: '860px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '4px' }}>Admin Panel</h2>
      <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '24px' }}>
        Managing <strong style={{ color: '#e8e0d0' }}>{activeCollectionName}</strong> — switch groups to administer a different one.
      </p>

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

      {pendingDelete && (
        <ConfirmDeleteModal
          title={pendingDelete.kind === 'email' ? 'Remove email' : 'Remove member'}
          description={
            pendingDelete.kind === 'email'
              ? 'This removes the email from the invite list. It will not affect an account that already registered with it.'
              : `This removes them from ${activeCollectionName} (their minis here go with it). If this is their only group, their whole account is deleted too. This cannot be undone.`
          }
          confirmPhrase={pendingDelete.label}
          confirmButtonLabel={pendingDelete.kind === 'email' ? 'Delete' : 'Confirm Delete'}
          onConfirm={() => void confirmPendingDelete()}
          onCancel={() => setPendingDelete(null)}
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
