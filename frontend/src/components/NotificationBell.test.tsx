import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import NotificationBell, { POLL_INTERVAL_MS } from './NotificationBell';
import { NotificationItem, LOANS_CHANGED_EVENT } from '../api/client';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 1, type: 'your_turn', message: 'It\'s your turn — you can now negotiate for Dire Wolf',
    miniId: 42, loanId: 9, read: false, createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function mockInbox(inbox: { unread: number; items: NotificationItem[] }) {
  let current = inbox;
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/notifications' && !init?.method) return jsonResponse(current);
    if (url === '/api/notifications/read-all') {
      current = { unread: 0, items: current.items.map(i => ({ ...i, read: true })) };
      return jsonResponse({ message: 'All read' });
    }
    const one = url.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (one) {
      current = {
        unread: Math.max(0, current.unread - 1),
        items: current.items.map(i => (i.id === Number(one[1]) ? { ...i, read: true } : i)),
      };
      return jsonResponse({ message: 'Read' });
    }
    return jsonResponse({});
  });
  return { set: (next: typeof inbox) => { current = next; } };
}

function renderBell(collectionId = 5) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <NotificationBell collectionId={collectionId} />
      <Routes>
        <Route path="/" element={<div>Browse page</div>} />
        <Route path="/loans" element={<div>Loans page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows how many notifications are unread', async () => {
    mockInbox({ unread: 3, items: [item()] });
    renderBell();

    expect(await screen.findByRole('button', { name: /notifications \(3 unread\)/i })).toBeInTheDocument();
  });

  it('shows no count when everything is read', async () => {
    mockInbox({ unread: 0, items: [item({ read: true })] });
    renderBell();

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /^notifications$/i })).toBeInTheDocument();
  });

  it('opens a list of notifications, newest first, with how long ago', async () => {
    mockInbox({
      unread: 1,
      items: [
        item({ id: 2, message: 'Bob requested Owlbear', type: 'request_created', createdAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
        item({ id: 1, message: 'A hold spot opened on Dire Wolf', type: 'spot_opened', loanId: null, read: true, createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }),
      ],
    });
    renderBell();

    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    const entries = screen.getAllByRole('listitem');
    expect(entries[0]).toHaveTextContent('Bob requested Owlbear');
    expect(entries[0]).toHaveTextContent('5m ago');
    expect(entries[1]).toHaveTextContent('A hold spot opened on Dire Wolf');
    expect(entries[1]).toHaveTextContent('3h ago');
  });

  it('says so when there are no notifications', async () => {
    mockInbox({ unread: 0, items: [] });
    renderBell();

    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument();
  });

  it('marks one read and goes to your loans when it\'s about a loan', async () => {
    mockInbox({ unread: 1, items: [item({ id: 7, loanId: 9 })] });
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: /notifications \(1 unread\)/i }));

    await userEvent.click(screen.getByRole('button', { name: /your turn/i }));

    expect(await screen.findByText('Loans page')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/notifications/7/read', expect.objectContaining({ method: 'POST' }));
    expect(await screen.findByRole('button', { name: /^notifications$/i })).toBeInTheDocument();
  });

  it('goes to the loans page for hold notifications too, where your holds are listed', async () => {
    mockInbox({ unread: 1, items: [item({ id: 8, type: 'moved_up', loanId: null, message: 'You moved up to #1 in line for Dire Wolf' })] });
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    await userEvent.click(screen.getByRole('button', { name: /moved up/i }));

    expect(await screen.findByText('Loans page')).toBeInTheDocument();
  });

  it('tells the Loans page to reload when a notification is opened', async () => {
    mockInbox({ unread: 1, items: [item({ id: 7 })] });
    const listener = vi.fn();
    window.addEventListener(LOANS_CHANGED_EVENT, listener);
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: /notifications \(1 unread\)/i }));

    await userEvent.click(screen.getByRole('button', { name: /your turn/i }));

    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    window.removeEventListener(LOANS_CHANGED_EVENT, listener);
  });

  it('checks for new notifications when opened, not just once a minute', async () => {
    const inbox = mockInbox({ unread: 0, items: [] });
    renderBell();
    await screen.findByRole('button', { name: /^notifications$/i });

    inbox.set({ unread: 1, items: [item({ message: 'Bob requested Owlbear' })] });
    await userEvent.click(screen.getByRole('button', { name: /^notifications/i }));

    expect(await screen.findByText('Bob requested Owlbear')).toBeInTheDocument();
  });

  it('marks all as read', async () => {
    mockInbox({ unread: 2, items: [item({ id: 1 }), item({ id: 2, message: 'Bob requested Owlbear' })] });
    renderBell();
    await userEvent.click(await screen.findByRole('button', { name: /notifications \(2 unread\)/i }));

    await userEvent.click(screen.getByRole('button', { name: /mark all read/i }));

    expect(await screen.findByRole('button', { name: /^notifications$/i })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith('/api/notifications/read-all', expect.objectContaining({ method: 'POST' }));
  });

  it('checks for new notifications every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inbox = mockInbox({ unread: 0, items: [] });
    renderBell();
    await screen.findByRole('button', { name: /^notifications$/i });

    inbox.set({ unread: 1, items: [item()] });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS); });

    expect(await screen.findByRole('button', { name: /notifications \(1 unread\)/i })).toBeInTheDocument();
  });

  it('reloads when you switch groups', async () => {
    mockInbox({ unread: 0, items: [] });
    const { rerender } = renderBell(5);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    rerender(
      <MemoryRouter>
        <NotificationBell collectionId={6} />
      </MemoryRouter>
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('copes with an unexpected response', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({}));
    renderBell();

    await userEvent.click(await screen.findByRole('button', { name: /notifications/i }));

    expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument();
  });
});
