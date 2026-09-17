import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../App';

type Profile = {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
};

// Lets a user view their account info and edit their own display name,
// phone, and neighborhood. Reached by clicking your username in the nav bar.
export default function ProfilePage(): React.ReactElement {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [confirmingLogoutAll, setConfirmingLogoutAll] = useState<boolean>(false);

  const [displayName, setDisplayName]   = useState<string>('');
  const [phone, setPhone]               = useState<string>('');
  const [neighborhood, setNeighborhood] = useState<string>('');

  const [error, setError]     = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const [loadError, setLoadError] = useState<string>('');

  useEffect(() => {
    api<Profile>('/api/users/me')
      .then((p: Profile) => {
        setProfile(p);
        setDisplayName(p.display_name);
        setPhone(p.phone ?? '');
        setNeighborhood(p.neighborhood ?? '');
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load your profile'));
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }

    setLoading(true);
    try {
      const updated = await api<Profile>('/api/users/me', {
        method: 'PATCH',
        json: { displayName, phone, neighborhood },
      });
      setProfile(updated);
      setSuccess('Profile updated');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      setLoading(false);
    }
  }

  // Ends every session this account has — use it after signing in on a
  // shared computer, or if a device was lost.
  async function logOutEverywhere(): Promise<void> {
    setError('');
    try {
      await api('/api/auth/logout-all', { method: 'POST' });
      setUser(null);
      navigate('/login');
    } catch (err: unknown) {
      setConfirmingLogoutAll(false);
      setError(err instanceof Error ? err.message : 'Failed to log out everywhere');
    }
  }

  if (loadError) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: '480px', margin: '0 auto' }}>
        <div className="error-msg">{loadError}</div>
      </div>
    );
  }

  if (!profile) {
    return <div style={{ padding: '28px 32px', color: '#8a7d6a' }}>Loading…</div>;
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: '480px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '22px', color: '#c9a84c', marginBottom: '8px' }}>My Profile</h2>
      <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '24px' }}>
        {profile.username} · {profile.email}
      </p>

      <form onSubmit={handleSubmit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        {error && <div className="error-msg">{error}</div>}
        {success && <div className="success-msg">{success}</div>}

        <div>
          <label style={labelStyle} htmlFor="profile-display-name">Display Name</label>
          <input
            id="profile-display-name"
            type="text"
            value={displayName}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)}
            maxLength={100}
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="profile-phone">
            Phone <span style={{ color: '#8a7d6a', textTransform: 'none', fontSize: '11px' }}>(optional)</span>
          </label>
          <input
            id="profile-phone"
            type="tel"
            value={phone}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)}
            maxLength={20}
          />
        </div>

        <div>
          <label style={labelStyle} htmlFor="profile-neighborhood">
            Neighborhood <span style={{ color: '#8a7d6a', textTransform: 'none', fontSize: '11px' }}>(optional)</span>
          </label>
          <input
            id="profile-neighborhood"
            type="text"
            value={neighborhood}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNeighborhood(e.target.value)}
            maxLength={100}
          />
        </div>

        <button className="btn-primary" type="submit" disabled={loading} style={{ padding: '12px' }}>
          {loading ? 'Saving…' : 'Save'}
        </button>
      </form>

      <div style={{ marginTop: '32px', paddingTop: '20px', borderTop: '1px solid #3d3629' }}>
        <h3 style={{ fontSize: '15px', color: '#c9a84c', marginBottom: '6px' }}>Sessions</h3>
        <p style={{ fontSize: '13px', color: '#8a7d6a', marginBottom: '12px' }}>
          Sign out on every phone and computer where you're signed in, including this one.
        </p>
        {confirmingLogoutAll ? (
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button type="button" className="btn-danger" onClick={() => void logOutEverywhere()}>
              Yes, log out everywhere
            </button>
            <button type="button" className="btn-secondary" onClick={() => setConfirmingLogoutAll(false)}>
              Keep me signed in
            </button>
          </div>
        ) : (
          <button type="button" className="btn-secondary" onClick={() => setConfirmingLogoutAll(true)}>
            Log out everywhere
          </button>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 500,
  color: '#8a7d6a',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};
