import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import RegisterPage from './RegisterPage';
import { AuthContext } from '../App';

function renderRegisterPage() {
  const setUser = vi.fn();
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: null, loading: false, setUser }}>
        <RegisterPage />
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { setUser };
}

async function fillForm(
  overrides: Partial<{ email: string; username: string; password: string; confirm: string }> = {}
) {
  const user = userEvent.setup();
  const values = {
    email: 'test@example.com',
    username: 'valid_user',
    password: 'validpass1',
    confirm: 'validpass1',
    ...overrides,
  };

  await user.type(screen.getByLabelText(/email/i), values.email);
  await user.type(screen.getByLabelText(/^username$/i), values.username);
  await user.type(screen.getByLabelText(/^password$/i), values.password);
  await user.type(screen.getByLabelText(/confirm password/i), values.confirm);
  await user.click(screen.getByRole('button', { name: /create account/i }));
}

describe('RegisterPage validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('rejects a username that is too short and does not call the API', async () => {
    const { setUser } = renderRegisterPage();
    await fillForm({ username: 'ab' });

    expect(await screen.findByText(/username must be between/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(setUser).not.toHaveBeenCalled();
  });

  it('rejects a username containing special characters (SQL-breaking input)', async () => {
    renderRegisterPage();
    await fillForm({ username: "drop_table'--" });

    expect(await screen.findByText(/letters, numbers, and underscores/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a password shorter than 8 characters', async () => {
    renderRegisterPage();
    await fillForm({ password: 'short1', confirm: 'short1' });

    expect(await screen.findByText(/password must be between/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a password containing special characters', async () => {
    renderRegisterPage();
    await fillForm({ password: 'valid pass1', confirm: 'valid pass1' });

    expect(await screen.findByText(/letters and numbers/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('submits to the API when all fields are valid', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ userId: 1, username: 'valid_user', role: 'user', displayName: 'valid_user' }),
    } as Response);

    const { setUser } = renderRegisterPage();
    await fillForm();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(setUser).toHaveBeenCalled();
  });
});
