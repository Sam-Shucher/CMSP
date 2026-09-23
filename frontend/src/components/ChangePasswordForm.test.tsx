import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChangePasswordForm from './ChangePasswordForm';
import { resyncPush } from '../push';
import { jsonResponse, jsonBodyOf } from '../test/apiMock';

// A password change makes the server forget every device's phone
// notifications; this device has to sign straight back up.
vi.mock('../push', () => ({ resyncPush: vi.fn(async () => {}) }));

function renderForm(props: { onChanged?: () => void } = {}) {
  const onChanged = props.onChanged ?? vi.fn();
  render(<ChangePasswordForm onChanged={onChanged} />);
  return { onChanged };
}

async function fill(options: { current?: string; next?: string; confirm?: string } = {}) {
  const { current = 'the old password 1', next = 'a brand new password 2', confirm = next } = options;
  await userEvent.type(screen.getByLabelText('Current password'), current);
  await userEvent.type(screen.getByLabelText('New password'), next);
  await userEvent.type(screen.getByLabelText('Confirm new password'), confirm);
}

describe('ChangePasswordForm', () => {
  beforeEach(() => {
    vi.mocked(resyncPush).mockClear();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'Password changed' })));
  });

  it('sends the current and new password, then says it worked', async () => {
    const { onChanged } = renderForm();

    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/users/me/password');
    expect(init?.method).toBe('PATCH');
    expect(jsonBodyOf(init)).toEqual({ currentPassword: 'the old password 1', newPassword: 'a brand new password 2' });
    expect(await screen.findByText('Password changed.')).toBeInTheDocument();
  });

  it('empties the boxes afterwards, so the password isn\'t left on screen', async () => {
    renderForm();

    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(screen.getByLabelText('Current password')).toHaveValue(''));
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(screen.getByLabelText('Confirm new password')).toHaveValue('');
  });

  it('points out when the two new passwords don\'t match, without asking the server', async () => {
    renderForm();

    await fill({ confirm: 'something else entirely' });
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('Those two passwords don\'t match.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks for at least 8 characters before sending anything', async () => {
    renderForm();

    await fill({ next: 'short', confirm: 'short' });
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the server\'s reply when the current password is wrong', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'That current password isn\'t right' }, { ok: false, status: 401 }));
    const { onChanged } = renderForm();

    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByText('That current password isn\'t right')).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('signs this device back up for phone notifications once the password has changed', async () => {
    const { onChanged } = renderForm();

    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(resyncPush).toHaveBeenCalledTimes(1);
  });

  it('leaves phone notifications alone when the change is refused', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'That current password isn\'t right' }, { ok: false, status: 401 }));
    renderForm();

    await fill();
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }));

    await screen.findByText('That current password isn\'t right');
    expect(resyncPush).not.toHaveBeenCalled();
  });

  it('uses password fields a password manager can fill', () => {
    renderForm();

    expect(screen.getByLabelText('Current password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Current password')).toHaveAttribute('autoComplete', 'current-password');
    expect(screen.getByLabelText('New password')).toHaveAttribute('autoComplete', 'new-password');
    expect(screen.getByLabelText('New password')).toHaveAttribute('maxLength', '72');
  });
});
