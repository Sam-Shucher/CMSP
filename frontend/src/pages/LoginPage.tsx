import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../App';
import { useValidatedForm } from '../hooks/useValidatedForm';
import FieldError from '../components/FieldError';
import { validateEmail } from '../utils/validation';

export default function LoginPage(): React.ReactElement {
  const { refreshSession, sessionNotice } = useAuth();
  const navigate = useNavigate();

  // Problems are pointed out after a pause, on leaving a field, or on Sign In —
  // never mid-keystroke (see useValidatedForm).
  const form = useValidatedForm({ email: '', password: '' }, {
    email: value => validateEmail(value).error ?? null,
    password: value => (value ? null : 'Enter your password.'),
  });
  const [error, setError]       = useState<string>('');
  const [loading, setLoading]   = useState<boolean>(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault(); // prevent the browser from doing a full page reload
    setError('');
    if (!form.validateAll()) return;
    setLoading(true);

    try {
      await api('/api/auth/login', {
        method: 'POST',
        json: { email: form.values.email.trim(), password: form.values.password },
      });
      // Re-fetch the session from the server rather than trusting this
      // response body directly — it picks up collectionId (and re-derives
      // it from the fresh cookie, the actual source of truth) in one place.
      await refreshSession();
      navigate('/'); // redirect to the dashboard
    } catch (err: unknown) {
      // Display the server's error message (e.g. "Invalid email or password")
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={pageStyle}>
      <div style={cardStyle}>
        <h1 style={{ fontSize: '24px', marginBottom: '8px', color: '#c9a84c' }}>Mini Library</h1>
        <p style={{ color: 'var(--text-muted)', marginBottom: '28px', fontSize: '14px' }}>
          Sign in to browse and share your collection
        </p>

        {/* noValidate: no browser popups — our own messages show under each field */}
        <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Why they were signed out (e.g. logged out on another device), unless a newer error replaced it */}
          {sessionNotice && !error && <div className="error-msg" role="status">{sessionNotice}</div>}

          {/* Show the server error message if login failed */}
          {error && <div className="error-msg">{error}</div>}

          <div>
            <label htmlFor="login-email" style={labelStyle}>Email</label>
            <input
              {...form.field('email', 'login-email')}
              type="email"
              autoComplete="email"
              placeholder="your@email.com"
              required
              autoFocus
            />
            <FieldError id="login-email" message={form.errorFor('email')} />
          </div>

          <div>
            <label htmlFor="login-password" style={labelStyle}>Password</label>
            <input
              {...form.field('password', 'login-password')}
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              required
            />
            <FieldError id="login-password" message={form.errorFor('password')} />
          </div>

          <button
            className="btn-primary"
            type="submit"
            disabled={loading}
            style={{ marginTop: '6px', padding: '12px' }}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        {/* There's no email in this app, so a reset goes through a person. */}
        <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '13px', color: 'var(--text-muted)' }}>
          Forgotten your password? Ask an admin of your group — they can set a temporary
          one and pass it on to you.
        </p>

        <p style={{ textAlign: 'center', marginTop: '12px', fontSize: '14px', color: 'var(--text-muted)' }}>
          Don't have an account?{' '}
          <Link to="/register">Register with your invite</Link>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — defined as constants so they don't get recreated on every render
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
  padding: '40px',
  width: '100%',
  maxWidth: '400px',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text-muted)',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
