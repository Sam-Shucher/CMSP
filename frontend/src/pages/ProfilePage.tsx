import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../App';
import { useValidatedForm } from '../hooks/useValidatedForm';
import FieldError from '../components/FieldError';

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

  // Problems are pointed out under the field after a pause, on leaving it, or
  // on save (see useValidatedForm). Phone and neighborhood only have length
  // limits, which the inputs enforce.
  const form = useValidatedForm({ displayName: '', phone: '', neighborhood: '' }, {
    displayName: value => (value.trim() ? null : 'Display name can\'t be blank — it\'s how others see you.'),
  });

  const [error, setError]     = useState<string>('');
  const [success, setSuccess] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const [loadError, setLoadError] = useState<string>('');

  useEffect(() => {
    api<Profile>('/api/users/me')
      .then((p: Profile) => {
        setProfile(p);
        form.reset({ displayName: p.display_name, phone: p.phone ?? '', neighborhood: p.neighborhood ?? '' });
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : 'Failed to load your profile'));
    // Loads once: `form` is new each render, and re-running would overwrite
    // what the person has typed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!form.validateAll()) return;

    setLoading(true);
    try {
      const updated = await api<Profile>('/api/users/me', {
        method: 'PATCH',
        json: form.values,
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
          <input {...form.field('displayName', 'profile-display-name')} type="text" maxLength={100} />
          <FieldError id="profile-display-name" message={form.errorFor('displayName')} />
        </div>

        <div>
          <label style={labelStyle} htmlFor="profile-phone">
            Phone <span style={{ color: '#8a7d6a', textTransform: 'none', fontSize: '11px' }}>(optional)</span>
          </label>
          <input {...form.field('phone', 'profile-phone')} type="tel" maxLength={20} />
        </div>

        <div>
          <label style={labelStyle} htmlFor="profile-neighborhood">
            Neighborhood <span style={{ color: '#8a7d6a', textTransform: 'none', fontSize: '11px' }}>(optional)</span>
          </label>
          <input {...form.field('neighborhood', 'profile-neighborhood')} type="text" maxLength={100} />
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
