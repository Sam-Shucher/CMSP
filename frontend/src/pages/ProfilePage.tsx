import React, { useEffect, useState } from 'react';
import { api } from '../api/client';

type Profile = {
  id: number;
  email: string;
  username: string;
  display_name: string;
  phone: string | null;
  neighborhood: string | null;
  role: string;
};

// Lets a user view their account info and edit their own display name,
// phone, and neighborhood. Reached by clicking your username in the nav bar.
export default function ProfilePage(): React.ReactElement {
  const [profile, setProfile] = useState<Profile | null>(null);

  const [displayName, setDisplayName]   = useState<string>('');
  const [phone, setPhone]               = useState<string>('');
  const [neighborhood, setNeighborhood] = useState<string>('');

  const [error, setError]     = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    api<Profile>('/api/users/me').then((p: Profile) => {
      setProfile(p);
      setDisplayName(p.display_name);
      setPhone(p.phone ?? '');
      setNeighborhood(p.neighborhood ?? '');
    });
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
