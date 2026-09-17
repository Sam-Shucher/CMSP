import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import RegisterPage from './RegisterPage';
import { AuthContext } from '../App';

function renderRegisterPage() {
  const setUser = vi.fn();
  const refreshSession = vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user: null, loading: false, setUser, collections: [], selectCollection: vi.fn(), refreshSession }}>
        <RegisterPage />
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { setUser, refreshSession };
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

    expect(await screen.findByText(/password must be at least 8/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a password with spaces and symbols', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    renderRegisterPage();
    await fillForm({ password: 'correct horse! battery#9', confirm: 'correct horse! battery#9' });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body)).password).toBe('correct horse! battery#9');
  });

  it('lets password managers fill in long passwords (up to 72 characters)', () => {
    renderRegisterPage();

    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('maxLength', '72');
    expect(screen.getByLabelText(/confirm password/i)).toHaveAttribute('maxLength', '72');
  });

  it('rejects passwords that do not match, without calling the API', async () => {
    renderRegisterPage();
    await fillForm({ confirm: 'different1' });

    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the server\'s error (e.g. not on the invite list) and does not log in', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: 'This email is not on the invite list. Ask an admin to add you.' }),
    } as Response);

    const { refreshSession } = renderRegisterPage();
    await fillForm();

    expect(await screen.findByText(/not on the invite list/i)).toBeInTheDocument();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled();
  });

  it('sends the optional fields when filled in, never the password confirmation', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    renderRegisterPage();

    await userEvent.type(screen.getByLabelText(/display name/i), 'Merric');
    await userEvent.type(screen.getByLabelText(/phone/i), '555-1234');
    await userEvent.type(screen.getByLabelText(/neighborhood/i), 'Riverside');
    await fillForm();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({
      email: 'test@example.com',
      username: 'valid_user',
      displayName: 'Merric',
      phone: '555-1234',
      neighborhood: 'Riverside',
      password: 'validpass1',
    });
  });

  it('defaults the display name to the username and omits blank optional fields', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    renderRegisterPage();
    await fillForm();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.displayName).toBe('valid_user');
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('neighborhood');
    expect(body).not.toHaveProperty('confirm');
  });

  it('submits to the API when all fields are valid, then refreshes the session from the server', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ username: 'valid_user', role: 'user', displayName: 'valid_user', collectionId: 5 }),
    } as Response);

    const { refreshSession } = renderRegisterPage();
    await fillForm();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(refreshSession).toHaveBeenCalled();
  });
});
