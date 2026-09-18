import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import LoginPage from './LoginPage';
import { AuthContext } from '../App';

function renderLoginPage() {
  const refreshSession = vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthContext.Provider value={{ user: null, loading: false, setUser: vi.fn(), collections: [], selectCollection: vi.fn(), refreshSession }}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<div>Register page</div>} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>
  );
  return { refreshSession };
}

async function signIn(email: string, password: string) {
  await userEvent.type(screen.getByLabelText(/email/i), email);
  await userEvent.type(screen.getByLabelText(/password/i), password);
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('LoginPage — when problems are pointed out', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const emailInput = () => screen.getByLabelText(/email/i);
  const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

  // No email in this app, so the way back in is a person, not a reset link.
  it('says how to get back in after forgetting a password', () => {
    renderLoginPage();

    expect(screen.getByText(/ask an admin of your group/i)).toBeInTheDocument();
  });

  it('turns off the browser\'s own validation popups', () => {
    renderLoginPage();
    expect(document.querySelector('form')).toHaveAttribute('novalidate');
  });

  it('says nothing while you\'re still typing an email', () => {
    renderLoginPage();

    type(emailInput(), 'd');
    act(() => { vi.advanceTimersByTime(1000); });
    type(emailInput(), 'dtg');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(emailInput()).toHaveAttribute('aria-invalid', 'false');
  });

  it('points out an incomplete email after you pause for 3 seconds', () => {
    renderLoginPage();

    type(emailInput(), 'dtg');
    act(() => { vi.advanceTimersByTime(3000); });

    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email like name@example.com.');
    expect(emailInput()).toHaveAttribute('aria-invalid', 'true');
  });

  it('points it out as soon as you move on to the password', () => {
    renderLoginPage();

    type(emailInput(), 'dtg');
    fireEvent.blur(emailInput());

    expect(screen.getByRole('alert')).toHaveTextContent('Enter an email like name@example.com.');
  });

  it('clears the message once the email is fixed', () => {
    renderLoginPage();
    type(emailInput(), 'dtg');
    fireEvent.blur(emailInput());

    type(emailInput(), 'dtg@example.com');
    fireEvent.blur(emailInput());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('on Sign In, shows every problem and sends nothing', () => {
    renderLoginPage();

    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('LoginPage', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('logs in, refreshes the session from the server, and goes to the dashboard', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ message: 'Logged in' }) } as Response);
    const { refreshSession } = renderLoginPage();

    await signIn('owner@example.com', 'validpass1');

    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: JSON.stringify({ email: 'owner@example.com', password: 'validpass1' }),
    }));
  });

  it('shows the server\'s error on bad credentials and stays on the login page', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Invalid email or password' }) } as Response);
    const { refreshSession } = renderLoginPage();

    await signIn('owner@example.com', 'wrongpass1');

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(refreshSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });

  it('clears an old error when trying again', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Invalid email or password' }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);
    renderLoginPage();

    await signIn('owner@example.com', 'wrongpass1');
    await screen.findByText('Invalid email or password');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.queryByText('Invalid email or password')).not.toBeInTheDocument());
  });

  it('disables the button while signing in, so it can\'t be submitted twice', async () => {
    let finish!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    renderLoginPage();

    await signIn('owner@example.com', 'validpass1');

    expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled();
    finish({ ok: true, json: async () => ({}) } as Response);
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('uses a password field that hides what is typed', () => {
    renderLoginPage();
    expect(screen.getByLabelText(/password/i)).toHaveAttribute('type', 'password');
  });

  it('links to registration', async () => {
    renderLoginPage();

    await userEvent.click(screen.getByRole('link', { name: /register/i }));

    expect(await screen.findByText('Register page')).toBeInTheDocument();
  });
});
