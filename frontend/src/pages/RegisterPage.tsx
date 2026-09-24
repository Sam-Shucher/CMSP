import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../App';
import { validateUsername, validatePassword, validateEmail } from '../utils/validation';
import { useValidatedForm } from '../hooks/useValidatedForm';
import FieldError from '../components/FieldError';

// All fields the registration form tracks.
type FormState = {
  email: string;
  username: string;
  displayName: string;
  phone: string;        // optional
  neighborhood: string; // optional
  password: string;
  confirm: string; // password confirmation — only used client-side, never sent to the server
};

const EMPTY: FormState = { email: '', username: '', displayName: '', phone: '', neighborhood: '', password: '', confirm: '' };

export default function RegisterPage(): React.ReactElement {
  const { refreshSession } = useAuth();
  const navigate = useNavigate();

  // Problems are pointed out after a pause, on leaving a field, or on Create
  // Account — never mid-keystroke, and each under its own field. The optional
  // fields only have length limits, which the inputs themselves enforce.
  const form = useValidatedForm<FormState>(EMPTY, {
    email: value => validateEmail(value).error ?? null,
    username: value => (value ? validateUsername(value).error ?? null : 'Choose a username.'),
    password: value => validatePassword(value).error ?? null,
    confirm: (value, all) => (!value ? 'Type your password again.' : value !== all.password ? 'Passwords don\'t match.' : null),
  });
  const [error, setError]     = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    if (!form.validateAll()) return;

    const values = form.values;
    setLoading(true);
    try {
      // The server will check if this email is on a collection's invite list
      await api('/api/auth/register', {
        method: 'POST',
        json: {
          email: values.email.trim(),
          username: values.username,
          displayName: values.displayName || values.username,
          phone: values.phone || undefined,
          neighborhood: values.neighborhood || undefined,
          password: values.password,
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
        <p style={{ color: 'var(--text-muted)', marginBottom: '24px', fontSize: '13px' }}>
          You need an invite email to register.
        </p>

        {/* noValidate: no browser popups — our own messages show under each field */}
        <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '13px' }}>
          {/* Problems the server reports, like an email that isn't invited */}
          {error && <div className="error-msg">{error}</div>}

          <div>
            <label style={labelStyle} htmlFor="email">Email (must be on the invite list)</label>
            <input {...form.field('email', 'email')} type="email" autoComplete="email" placeholder="your@email.com" required autoFocus />
            <FieldError id="email" message={form.errorFor('email')} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="username">Username</label>
            <input {...form.field('username', 'username')} type="text" autoComplete="username" placeholder="dungeon_master_42" required maxLength={32} />
            <FieldError id="username" message={form.errorFor('username')} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="displayName">
              Display Name{' '}
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <input {...form.field('displayName', 'displayName')} type="text" placeholder="Merric the Bard" maxLength={100} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="phone">
              Phone{' '}
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <input {...form.field('phone', 'phone')} type="tel" autoComplete="tel" placeholder="555-123-4567" maxLength={20} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="neighborhood">
              Neighborhood{' '}
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <input {...form.field('neighborhood', 'neighborhood')} type="text" placeholder="Downtown" maxLength={100} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="password">Password</label>
            <input {...form.field('password', 'password')} type="password" autoComplete="new-password" placeholder="At least 8 characters, any kind" required maxLength={72} />
            <FieldError id="password" message={form.errorFor('password')} />
          </div>

          <div>
            <label style={labelStyle} htmlFor="confirm">Confirm Password</label>
            <input {...form.field('confirm', 'confirm')} type="password" autoComplete="new-password" placeholder="••••••••" required maxLength={72} />
            <FieldError id="confirm" message={form.errorFor('confirm')} />
          </div>

          <button className="btn-primary" type="submit" disabled={loading} style={{ marginTop: '6px', padding: '12px' }}>
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px', color: 'var(--text-muted)' }}>
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
  color: 'var(--text-muted)',
  marginBottom: '5px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
