import React, { useState } from 'react';
import { api } from '../api/client';
import FieldError from './FieldError';
import { useValidatedForm } from '../hooks/useValidatedForm';
import { validatePassword } from '../utils/validation';

const MAX_PASSWORD_BYTES = 72; // bcrypt ignores anything past this

type ChangePasswordFormProps = {
  // Called once the server has accepted the new password.
  onChanged?: () => void;
};

// Changing your own password: used from the profile page, and on the screen
// shown to someone an admin has given a temporary password to.
export default function ChangePasswordForm({ onChanged }: ChangePasswordFormProps): React.ReactElement {
  const form = useValidatedForm({ current: '', next: '', confirm: '' }, {
    current: value => (value ? null : 'Enter your current password.'),
    next: value => validatePassword(value).error ?? null,
    confirm: (value, all) => (value === all.next ? null : 'Those two passwords don\'t match.'),
  });

  const [error, setError] = useState<string>('');
  const [done, setDone] = useState<boolean>(false);
  const [saving, setSaving] = useState<boolean>(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setDone(false);
    if (!form.validateAll()) return;

    setSaving(true);
    try {
      await api('/api/users/me/password', {
        method: 'PATCH',
        json: { currentPassword: form.values.current, newPassword: form.values.next },
      });
      form.reset(); // don't leave passwords sitting in the boxes
      setDone(true);
      onChanged?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate style={{ display: 'grid', gap: '14px' }}>
      {error && <div className="error-msg">{error}</div>}
      {done && <div className="success-msg">Password changed.</div>}

      <div>
        <label style={labelStyle} htmlFor="current-password">Current password</label>
        <input {...form.field('current', 'current-password')} type="password" autoComplete="current-password" maxLength={MAX_PASSWORD_BYTES} />
        <FieldError id="current-password" message={form.errorFor('current')} />
      </div>

      <div>
        <label style={labelStyle} htmlFor="new-password">New password</label>
        <input {...form.field('next', 'new-password')} type="password" autoComplete="new-password" maxLength={MAX_PASSWORD_BYTES} />
        <FieldError id="new-password" message={form.errorFor('next')} />
      </div>

      <div>
        <label style={labelStyle} htmlFor="confirm-password">Confirm new password</label>
        <input {...form.field('confirm', 'confirm-password')} type="password" autoComplete="new-password" maxLength={MAX_PASSWORD_BYTES} />
        <FieldError id="confirm-password" message={form.errorFor('confirm')} />
      </div>

      <button type="submit" className="btn-primary" disabled={saving} style={{ justifySelf: 'start', padding: '10px 18px' }}>
        {saving ? 'Changing…' : 'Change password'}
      </button>
    </form>
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
