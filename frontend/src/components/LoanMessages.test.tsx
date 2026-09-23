import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LoanMessages from './LoanMessages';
import { LoanMessage } from '../api/client';
import { jsonResponse, urlOf, jsonBodyOf } from '../test/apiMock';

// "Running 20 minutes late" — said on the loan itself instead of in a text
// thread the app never sees. Shut until opened, like the condition notes, so
// the page doesn't fetch a thread per card on every load.

const THEIRS: LoanMessage = {
  id: 1, authorId: 10, authorName: 'Alice', mine: false,
  body: 'Front door, ring twice', read: false, createdAt: '2026-10-01T17:40:00.000Z',
};

const MINE: LoanMessage = {
  id: 2, authorId: 4, authorName: 'Bruno', mine: true,
  body: 'Running 20 minutes late', read: true, createdAt: '2026-10-01T17:45:00.000Z',
};

function mockApi(thread: LoanMessage[], actions: Record<string, () => Response> = {}) {
  const sent: { key: string; body: unknown }[] = [];
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${urlOf(input)}`;
    if (key !== 'GET /api/loans/5/messages') sent.push({ key, body: jsonBodyOf(init) });
    if (actions[key]) return actions[key]();
    if (key === 'GET /api/loans/5/messages') return jsonResponse(thread);
    if (key === 'POST /api/loans/5/messages/read') return jsonResponse({ read: 1 });
    return jsonResponse({ error: `unexpected ${key}` }, { ok: false });
  });
  return sent;
}

function renderThread(props: Partial<React.ComponentProps<typeof LoanMessages>> = {}) {
  const onChanged = props.onChanged ?? vi.fn();
  const view = render(
    <LoanMessages loanId={5} counterpartName="Alice" messageCount={0} unreadMessages={0} canPost onChanged={onChanged} {...props} />
  );
  return { ...view, onChanged };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('LoanMessages', () => {
  it('stays shut until asked, fetching nothing, but says how many are new', () => {
    mockApi([]);
    renderThread({ messageCount: 3, unreadMessages: 2 });

    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /messages \(3\) · 2 new/i })).toBeInTheDocument();
  });

  it('invites the first message when there are none yet', () => {
    mockApi([]);
    renderThread();

    expect(screen.getByRole('button', { name: /message alice/i })).toBeInTheDocument();
  });

  it('shows the thread in order, telling your messages from theirs', async () => {
    mockApi([THEIRS, MINE]);
    renderThread({ messageCount: 2 });

    await userEvent.click(screen.getByRole('button', { name: /messages \(2\)/i }));

    const list = await screen.findByRole('list', { name: /messages with alice/i });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Alice');
    expect(items[0]).toHaveTextContent('Front door, ring twice');
    expect(items[1]).toHaveTextContent('You');
    expect(items[1]).toHaveTextContent('Running 20 minutes late');
  });

  it('says when the other person has seen your message', async () => {
    mockApi([THEIRS, MINE]);
    renderThread({ messageCount: 2 });

    await userEvent.click(screen.getByRole('button', { name: /messages/i }));

    const items = within(await screen.findByRole('list', { name: /messages with alice/i })).getAllByRole('listitem');
    expect(items[1]).toHaveTextContent(/seen/i);
    expect(items[0]).not.toHaveTextContent(/seen/i);
  });

  it('marks the new ones seen once you open it, and lets the card catch up', async () => {
    const sent = mockApi([THEIRS]);
    const { onChanged } = renderThread({ messageCount: 1, unreadMessages: 1 });

    await userEvent.click(screen.getByRole('button', { name: /1 new/i }));

    await waitFor(() => expect(sent.map(s => s.key)).toContain('POST /api/loans/5/messages/read'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('marks nothing when there was nothing new', async () => {
    const sent = mockApi([MINE]);
    renderThread({ messageCount: 1 });

    await userEvent.click(screen.getByRole('button', { name: /messages \(1\)/i }));
    await screen.findByRole('list', { name: /messages with alice/i });

    expect(sent).toEqual([]);
  });

  it('sends a message, clears the box, and shows the thread the server sent back', async () => {
    const sent = mockApi([], {
      'POST /api/loans/5/messages': () => jsonResponse([MINE]),
    });
    const { onChanged } = renderThread();

    await userEvent.click(screen.getByRole('button', { name: /message alice/i }));
    const box = await screen.findByLabelText(/^message$/i);
    await userEvent.type(box, 'Running 20 minutes late');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText('Running 20 minutes late', { selector: 'p' })).toBeInTheDocument();
    expect(sent).toEqual([{ key: 'POST /api/loans/5/messages', body: { body: 'Running 20 minutes late' } }]);
    expect(box).toHaveValue('');
    expect(onChanged).toHaveBeenCalled();
  });

  it('sends on Enter, and Shift+Enter starts a new line instead', async () => {
    const sent = mockApi([], {
      'POST /api/loans/5/messages': () => jsonResponse([{ ...MINE, body: 'Front door.\nRing twice.' }]),
    });
    renderThread();

    await userEvent.click(screen.getByRole('button', { name: /message alice/i }));
    const box = await screen.findByLabelText(/^message$/i);
    await userEvent.type(box, 'Front door.{Shift>}{Enter}{/Shift}Ring twice.');
    expect(sent).toEqual([]);

    await userEvent.type(box, '{Enter}');

    await waitFor(() => expect(sent).toEqual([{ key: 'POST /api/loans/5/messages', body: { body: 'Front door.\nRing twice.' } }]));
  });

  it('will not send an empty message', async () => {
    mockApi([]);
    renderThread();

    await userEvent.click(screen.getByRole('button', { name: /message alice/i }));
    await userEvent.type(await screen.findByLabelText(/^message$/i), '   ');

    expect(screen.getByRole('button', { name: /^send$/i })).toBeDisabled();
  });

  // Once the loan is over the thread is a record: readable, not writable.
  it('shows a finished loan\'s thread with no way to add to it', async () => {
    mockApi([THEIRS, MINE]);
    renderThread({ messageCount: 2, canPost: false });

    await userEvent.click(screen.getByRole('button', { name: /messages \(2\)/i }));

    await screen.findByRole('list', { name: /messages with alice/i });
    expect(screen.queryByLabelText(/^message$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/kept as a record/i)).toBeInTheDocument();
  });

  it('offers nothing at all on a finished loan that never had a message', () => {
    mockApi([]);
    const { container } = renderThread({ canPost: false });

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the server\'s reason when a message is refused', async () => {
    mockApi([], {
      'POST /api/loans/5/messages': () =>
        jsonResponse({ error: 'This loan just ended — refresh to see where it stands' }, { ok: false, status: 409 }),
    });
    renderThread();

    await userEvent.click(screen.getByRole('button', { name: /message alice/i }));
    await userEvent.type(await screen.findByLabelText(/^message$/i), 'On my way');
    await userEvent.click(screen.getByRole('button', { name: /^send$/i }));

    expect(await screen.findByText(/just ended/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^message$/i)).toHaveValue('On my way'); // not lost
  });

  // The Loans page re-checks every loan every 30 seconds; a longer thread
  // than the one showing means the other person said something.
  it('reloads an open thread when the loan says it has grown', async () => {
    let thread = [THEIRS];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${urlOf(input)}`;
      if (key === 'GET /api/loans/5/messages') return jsonResponse(thread);
      return jsonResponse({ read: 1 });
    });
    const onChanged = vi.fn();
    const { rerender } = render(
      <LoanMessages loanId={5} counterpartName="Alice" messageCount={1} unreadMessages={0} canPost onChanged={onChanged} />
    );
    await userEvent.click(screen.getByRole('button', { name: /messages \(1\)/i }));
    await screen.findByText('Front door, ring twice');

    thread = [THEIRS, { ...THEIRS, id: 3, body: 'Actually, side door' }];
    rerender(<LoanMessages loanId={5} counterpartName="Alice" messageCount={2} unreadMessages={1} canPost onChanged={onChanged} />);

    expect(await screen.findByText('Actually, side door')).toBeInTheDocument();
  });
});
