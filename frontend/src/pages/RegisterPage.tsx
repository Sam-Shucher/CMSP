import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, User } from '../api/client';
import { useAuth } from '../App';

// All fields the registration form tracks.
// Defined as a named type so we can use keyof FormState for type-safe field updates.
type FormState = {
  email: string;
  username: string;
  displayName: string;
  password: string;
  confirm: string; // password confirmation — only used client-side, never sent to the server
};

export default function RegisterPage(): React.ReactElement {
  const { setUser } = useAuth();
  const navigate = useNavigate();

  const [form, setForm]       = useState<FormState>({ email: '', username: '', displayName: '', password: '', confirm: '' });
  const [error, setError]     = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  // Returns a change handler for a specific form field.
  // Using `keyof FormState` ensures only valid field names can be passed in —
  // TypeScript will error if you accidentally type 'passwrod' etc.
  function set(field: keyof FormState) {
    return (e: React.ChangeEvent<HTMLInputElement>): void => {
      setForm(prev => ({ ...prev, [field]: e.target.value }));
    };
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');

    // Client-side validation — catches simple mistakes before hitting the server
    if (form.password !== form.confirm) {
      setError('Passwords do not match');
      return;
    }
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(form.username)) {
      setError('Username can only contain letters, numbers, and underscores');
      return;
    }

    setLoading(true);
    try {
      // The server will check if this email is on the approved_emails invite list
      const data = await api<User>('/api/auth/register', {
        method: 'POST',
        json: {
          email: form.email,
          username: form.username,
          displayName: form.displayName || form.username,
          password: form.password,
          // confirm is NOT sent — it was only used for client-side validation
        },
      });
      setUser(data);
      navigate('/'); // redirect to dashboard on success
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: '22px', marginBottom: '6px', color: '#c9a84c' }}>Create Account</h1>
        <p style={{ color: '#8a7d6a', marginBottom: '24px', fontSize: '13px' }}>
          You need an invite email to register.
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
          {error && <div className="error-msg">{error}</div>}

          <div>
            <label style={labelStyle}>Email (must be on the invite list)</label>
            <input type="email" value={form.email} onChange={set('email')} placeholder="your@email.com" required autoFocus />
          </div>

          <div>
            <label style={labelStyle}>Username</label>
            <input type="text" value={form.username} onChange={set('username')} placeholder="dungeon_master_42" required maxLength={50} />
          </div>

          <div>
            <label style={labelStyle}>
              Display Name{' '}
              <span style={{ color: '#8a7d6a', fontWeight: 400 }}>(optional)</span>
            </label>
            <input type="text" value={form.displayName} onChange={set('displayName')} placeholder="Merric the Bard" maxLength={100} />
          </div>

          <div>
            <label style={labelStyle}>Password</label>
            <input type="password" value={form.password} onChange={set('password')} placeholder="At least 8 characters" required />
          </div>

          <div>
            <label style={labelStyle}>Confirm Password</label>
            <input type="password" value={form.confirm} onChange={set('confirm')} placeholder="••••••••" required />
          </div>

          <button className="btn-primary" type="submit" disabled={loading} style={{ marginTop: '6px', padding: '12px' }}>
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px', color: '#8a7d6a' }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const pageStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
};

const cardStyle: React.CSSProperties = {
  background: '#252219',
  border: '1px solid #3d3629',
  borderRadius: '10px',
  boxShadow: '0 4px 16px rgba(0,0,0,0.5)',
  padding: '36px 40px',
  width: '100%',
  maxWidth: '420px',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  color: '#8a7d6a',
  marginBottom: '5px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
