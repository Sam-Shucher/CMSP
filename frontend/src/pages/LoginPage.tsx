import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, User } from '../api/client';
import { useAuth } from '../App';

// The server returns the User fields plus a displayName on successful login.
// We only store the User portion (userId, username, role) in the auth context.
type LoginResponse = User & { displayName: string };

export default function LoginPage(): React.ReactElement {
  const { setUser } = useAuth();
  const navigate = useNavigate();

  // Controlled inputs — each has its own state string
  const [email, setEmail]       = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [error, setError]       = useState<string>('');
  const [loading, setLoading]   = useState<boolean>(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault(); // prevent the browser from doing a full page reload
    setError('');
    setLoading(true);

    try {
      const data = await api<LoginResponse>('/api/auth/login', {
        method: 'POST',
        json: { email, password },
      });
      // Store the logged-in user in context so the rest of the app can read it
      setUser({ userId: data.userId, username: data.username, role: data.role });
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
        <p style={{ color: '#8a7d6a', marginBottom: '28px', fontSize: '14px' }}>
          Sign in to browse and share your collection
        </p>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {/* Show the server error message if login failed */}
          {error && <div className="error-msg">{error}</div>}

          <div>
            <label style={labelStyle}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              autoFocus
            />
          </div>

          <div>
            <label style={labelStyle}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
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

        <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '14px', color: '#8a7d6a' }}>
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
  color: '#8a7d6a',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
