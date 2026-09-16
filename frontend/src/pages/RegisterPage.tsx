import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../App';
import { validateUsername, validatePassword } from '../utils/validation';

// All fields the registration form tracks.
// Defined as a named type so we can use keyof FormState for type-safe field updates.
type FormState = {
  email: string;
  username: string;
  displayName: string;
  phone: string;        // optional
  neighborhood: string; // optional
  password: string;
  confirm: string; // password confirmation — only used client-side, never sent to the server
};

export default function RegisterPage(): React.ReactElement {
  const { refreshSession } = useAuth();
  const navigate = useNavigate();

  const [form, setForm]       = useState<FormState>({ email: '', username: '', displayName: '', phone: '', neighborhood: '', password: '', confirm: '' });
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
    const usernameResult = validateUsername(form.username);
    if (!usernameResult.valid) {
      setError(usernameResult.error!);
      return;
    }
    const passwordResult = validatePassword(form.password);
    if (!passwordResult.valid) {
      setError(passwordResult.error!);
      return;
    }
    if (form.password !== form.confirm) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      // The server will check if this email is on a collection's invite list
      await api('/api/auth/register', {
        method: 'POST',
        json: {
          email: form.email,
          username: form.username,
          displayName: form.displayName || form.username,
          phone: form.phone || undefined,
          neighborhood: form.neighborhood || undefined,
          password: form.password,
          // confirm is NOT sent — it was only used for client-side validation
        },
      });
      // Re-fetch the session from the server — the register response never
      // included userId, and now also carries collectionId, so this is the
      // one place both come from the actual source of truth (the cookie).
      await refreshSession();
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
            <label style={labelStyle} htmlFor="email">Email (must be on the invite list)</label>
            <input id="email" type="email" value={form.email} onChange={set('email')} placeholder="your@email.com" required autoFocus />
          </div>

          <div>
            <label style={labelStyle} htmlFor="username">Username</label>
            <input id="username" type="text" value={form.username} onChange={set('username')} placeholder="dungeon_master_42" required maxLength={32} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="displayName">
              Display Name{' '}
              <span style={{ color: '#8a7d6a', fontWeight: 400 }}>(optional)</span>
            </label>
            <input id="displayName" type="text" value={form.displayName} onChange={set('displayName')} placeholder="Merric the Bard" maxLength={100} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="phone">
              Phone{' '}
              <span style={{ color: '#8a7d6a', fontWeight: 400 }}>(optional)</span>
            </label>
            <input id="phone" type="tel" value={form.phone} onChange={set('phone')} placeholder="555-123-4567" maxLength={20} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="neighborhood">
              Neighborhood{' '}
              <span style={{ color: '#8a7d6a', fontWeight: 400 }}>(optional)</span>
            </label>
            <input id="neighborhood" type="text" value={form.neighborhood} onChange={set('neighborhood')} placeholder="Downtown" maxLength={100} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="password">Password</label>
            <input id="password" type="password" value={form.password} onChange={set('password')} placeholder="At least 8 characters" required maxLength={32} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="confirm">Confirm Password</label>
            <input id="confirm" type="password" value={form.confirm} onChange={set('confirm')} placeholder="••••••••" required maxLength={32} />
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
