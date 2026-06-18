import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../api/client';

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
  role: string;       // 'user' | 'admin'
  created_at: string;
};

// Admin panel — lets admins manage the invite list and user roles.
// Access is gated by the AdminRoute wrapper in App.tsx.
export default function AdminPage(): React.ReactElement {
  const [emails, setEmails]     = useState<ApprovedEmail[]>([]);
  const [users, setUsers]       = useState<UserRow[]>([]);
  const [newEmail, setNewEmail] = useState<string>('');
  const [error, setError]       = useState<string>('');
  const [success, setSuccess]   = useState<string>('');
  const [loading, setLoading]   = useState<boolean>(false);

  // Fetches both the invite list and the user list in parallel.
  // Wrapped in useCallback so it can be added to the useEffect dependency array without
  // causing an infinite loop (the function reference stays stable across renders).
  const fetchData = useCallback(async (): Promise<void> => {
    const [e, u] = await Promise.all([
      api<ApprovedEmail[]>('/api/admin/approved-emails'),
      api<UserRow[]>('/api/admin/users'),
    ]);
    setEmails(e);
    setUsers(u);
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
    setLoading(true);
    try {
      await api('/api/admin/approved-emails', { method: 'POST', json: { email: newEmail } });
      setNewEmail('');
      setSuccess(`${newEmail} added to the invite list`);
      void fetchData(); // refresh the table
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add email');
    } finally {
      setLoading(false);
    }
  }

  // Removes an email from the invite list after confirmation
  async function removeEmail(id: number): Promise<void> {
    if (!confirm('Remove this email from the invite list?')) return;
    await api(`/api/admin/approved-emails/${id}`, { method: 'DELETE' });
    void fetchData();
  }

  // Toggles a user between 'user' and 'admin' roles
  async function toggleRole(userId: number, currentRole: string): Promise<void> {
    const newRole: string = currentRole === 'admin' ? 'user' : 'admin';
    if (!confirm(`Change this user's role to ${newRole}?`)) return;
    await api(`/api/admin/users/${userId}/role`, { method: 'PATCH', json: { role: newRole } });
    void fetchData();
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '860px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '28px' }}>Admin Panel</h2>

      {/* ------------------------------------------------------------------ */}
      {/* Invite list — who is allowed to create an account                   */}
      {/* ------------------------------------------------------------------ */}
      <section style={sectionStyle}>
        <h3 style={sectionHeadStyle}>Invite List</h3>
        <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '16px' }}>
          Only emails on this list can create an account.
        </p>

        {/* Add email form */}
        <form onSubmit={addEmail} style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
          <input
            type="email"
            value={newEmail}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewEmail(e.target.value)}
            placeholder="friend@example.com"
            required
            style={{ flex: 1 }}
          />
          <button className="btn-primary" type="submit" disabled={loading} style={{ whiteSpace: 'nowrap' }}>
            {loading ? 'Adding…' : 'Add Email'}
          </button>
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
                    onClick={() => void removeEmail(e.id)}
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
        <h3 style={sectionHeadStyle}>Registered Users</h3>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Username</th>
              <th style={thStyle}>Display Name</th>
              <th style={thStyle}>Email</th>
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
                <td style={tdStyle}>
                  {/* Admins get a green badge, regular users get a grey tag */}
                  <span className={u.role === 'admin' ? 'badge-available' : 'tag'}>{u.role}</span>
                </td>
                <td style={tdStyle}>{new Date(u.created_at).toLocaleDateString()}</td>
                <td style={tdStyle}>
                  <button
                    className="btn-secondary"
                    style={{ padding: '4px 10px', fontSize: '12px' }}
                    onClick={() => void toggleRole(u.id, u.role)}
                  >
                    {u.role === 'admin' ? 'Demote' : 'Make Admin'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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
