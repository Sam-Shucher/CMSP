import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { jsonResponse, urlOf } from '../test/apiMock';

// The browser side (permission, subscribing) is tested in push.test.ts; this
// is only what the Profile page shows and which buttons do what.
vi.mock('../push', () => ({
  pushStatus: vi.fn(),
  turnOnPush: vi.fn(async () => {}),
  turnOffPush: vi.fn(async () => {}),
}));

import PushSettings from './PushSettings';
import { pushStatus, turnOnPush, turnOffPush } from '../push';

const status = vi.mocked(pushStatus);
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  status.mockReset();
  vi.mocked(turnOnPush).mockReset().mockResolvedValue(undefined);
  vi.mocked(turnOffPush).mockReset().mockResolvedValue(undefined);
  fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    urlOf(input) === '/api/push/test' ? jsonResponse({ sent: 1 }) : jsonResponse({}));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PushSettings', () => {
  it('offers to turn it on, and shows it on afterwards', async () => {
    status.mockResolvedValueOnce('off').mockResolvedValueOnce('on');
    render(<PushSettings />);

    await userEvent.click(await screen.findByRole('button', { name: /turn on for this device/i }));

    expect(turnOnPush).toHaveBeenCalled();
    expect(await screen.findByText(/on for this device/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /turn off/i })).toBeInTheDocument();
  });

  it('shows why turning it on failed', async () => {
    status.mockResolvedValue('off');
    vi.mocked(turnOnPush).mockRejectedValue(new Error('Notifications are blocked for this site.'));
    render(<PushSettings />);

    await userEvent.click(await screen.findByRole('button', { name: /turn on/i }));

    expect(await screen.findByText('Notifications are blocked for this site.')).toBeInTheDocument();
  });

  it('turns it off for this device', async () => {
    status.mockResolvedValueOnce('on').mockResolvedValueOnce('off');
    render(<PushSettings />);

    await userEvent.click(await screen.findByRole('button', { name: /turn off/i }));

    expect(turnOffPush).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: /turn on/i })).toBeInTheDocument();
  });

  it('sends a test and says it went', async () => {
    status.mockResolvedValue('on');
    render(<PushSettings />);

    await userEvent.click(await screen.findByRole('button', { name: /send a test/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/sent/i);
    expect(fetchMock.mock.calls.some(([input]) => urlOf(input as RequestInfo) === '/api/push/test')).toBe(true);
  });

  it('says when a test reached no device', async () => {
    status.mockResolvedValue('on');
    fetchMock.mockResolvedValue(jsonResponse({ sent: 0 }));
    render(<PushSettings />);

    await userEvent.click(await screen.findByRole('button', { name: /send a test/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/nothing could be delivered/i);
  });

  // An iPhone in Safari (not the home-screen app) can't do it at all yet.
  it.each([
    ['needs-install', /add to home screen/i],
    ['unsupported', /can't show notifications/i],
    ['not-set-up', /aren't set up on the server/i],
    ['blocked', /site settings/i],
  ] as const)('explains %s instead of offering a switch', async (state, text) => {
    status.mockResolvedValue(state);
    render(<PushSettings />);

    expect(await screen.findByText(text)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
  });
});
