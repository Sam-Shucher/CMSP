import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BookingPanel from './BookingPanel';
import { MiniBookings } from '../api/client';
import { jsonResponse, urlOf, jsonBodyOf } from '../test/apiMock';

// A hold answers "tell me when it's free"; this answers "I need it for game
// night on the 14th". So the panel is about DAYS — it shows which are claimed
// and lets you claim some, whether or not the mini is free right now.

const DAY_MS = 24 * 60 * 60 * 1000;
function day(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

const EMPTY: MiniBookings = { max: 10, bookings: [] };

function mockApi(initial: MiniBookings, actions: Record<string, () => Response> = {}) {
  let calendar = initial;
  const sent: RequestInit[] = [];
  const setCalendar = (next: MiniBookings) => { calendar = next; };
  vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${urlOf(input)}`;
    if (actions[key]) {
      sent.push(init!);
      return actions[key]();
    }
    if (key === 'GET /api/bookings/minis/42') return jsonResponse(calendar);
    return jsonResponse({ error: `unexpected ${key}` }, { ok: false });
  });
  return { setCalendar, sent };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

describe('BookingPanel', () => {
  it('shows the claimed days to everyone, without naming who', async () => {
    mockApi({
      max: 10,
      bookings: [{ id: 1, startsOn: day(14), endsOn: day(16), holderName: null, note: null, mine: false, started: false }],
    });
    render(<BookingPanel miniId={42} isOwn={false} />);

    const list = await screen.findByRole('list', { name: /booked days/i });
    expect(list).toHaveTextContent(/booked/i);
    expect(list).not.toHaveTextContent(/wendy/i);
  });

  it('names the booker to the mini\'s owner', async () => {
    mockApi({
      max: 10,
      bookings: [{ id: 1, startsOn: day(14), endsOn: day(14), holderName: 'Wendy Waiting', note: 'game night', mine: false, started: false }],
    });
    render(<BookingPanel miniId={42} isOwn />);

    const list = await screen.findByRole('list', { name: /booked days/i });
    expect(list).toHaveTextContent('Wendy Waiting');
    expect(list).toHaveTextContent('game night');
  });

  it('books a single day by default, sending the same date at both ends', async () => {
    const { sent, setCalendar } = mockApi(EMPTY, {
      'POST /api/bookings/minis/42': () => {
        setCalendar({ max: 10, bookings: [{ id: 1, startsOn: day(14), endsOn: day(14), holderName: 'You', note: null, mine: true, started: false }] });
        return jsonResponse({ bookingId: 1 });
      },
    });
    render(<BookingPanel miniId={42} isOwn={false} />);

    fireEvent.change(await screen.findByLabelText(/^from$/i), { target: { value: day(14) } });
    await userEvent.click(screen.getByRole('button', { name: /book these days/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(jsonBodyOf(sent[0])).toEqual({ startsOn: day(14), endsOn: day(14), note: '' });
  });

  it('books a range when an end date is given', async () => {
    const { sent } = mockApi(EMPTY, {
      'POST /api/bookings/minis/42': () => jsonResponse({ bookingId: 1 }),
    });
    render(<BookingPanel miniId={42} isOwn={false} />);

    fireEvent.change(await screen.findByLabelText(/^from$/i), { target: { value: day(14) } });
    fireEvent.change(screen.getByLabelText(/^to$/i), { target: { value: day(16) } });
    await userEvent.type(screen.getByLabelText(/what for/i), 'tournament');
    await userEvent.click(screen.getByRole('button', { name: /book these days/i }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(jsonBodyOf(sent[0])).toEqual({ startsOn: day(14), endsOn: day(16), note: 'tournament' });
  });

  it('will not send without a start date', async () => {
    mockApi(EMPTY);
    render(<BookingPanel miniId={42} isOwn={false} />);

    await screen.findByLabelText(/^from$/i);

    expect(screen.getByRole('button', { name: /book these days/i })).toBeDisabled();
  });

  it('shows the server\'s reason when the days are taken', async () => {
    mockApi(EMPTY, {
      'POST /api/bookings/minis/42': () =>
        jsonResponse({ error: 'Theo Third already has this booked for those days — pick another date' }, { ok: false, status: 409 }),
    });
    render(<BookingPanel miniId={42} isOwn={false} />);

    fireEvent.change(await screen.findByLabelText(/^from$/i), { target: { value: day(14) } });
    await userEvent.click(screen.getByRole('button', { name: /book these days/i }));

    expect(await screen.findByText(/already has this booked/i)).toBeInTheDocument();
  });

  it('lets you drop your own booking, and shows the days free again', async () => {
    const { setCalendar } = mockApi(
      { max: 10, bookings: [{ id: 7, startsOn: day(14), endsOn: day(14), holderName: 'You', note: null, mine: true, started: false }] },
      {
        'DELETE /api/bookings/7': () => {
          setCalendar(EMPTY);
          return jsonResponse({ message: 'Booking cancelled' });
        },
      }
    );
    render(<BookingPanel miniId={42} isOwn={false} />);

    await userEvent.click(await screen.findByRole('button', { name: /cancel this booking/i }));

    await waitFor(() => expect(screen.queryByRole('list', { name: /booked days/i })).not.toBeInTheDocument());
  });

  it('lets the owner drop someone else\'s booking on their mini', async () => {
    mockApi(
      { max: 10, bookings: [{ id: 7, startsOn: day(14), endsOn: day(14), holderName: 'Wendy Waiting', note: null, mine: false, started: false }] },
      { 'DELETE /api/bookings/7': () => jsonResponse({ message: 'Booking cancelled' }) }
    );
    render(<BookingPanel miniId={42} isOwn />);

    expect(await screen.findByRole('button', { name: /cancel wendy waiting's booking/i })).toBeInTheDocument();
  });

  // You can't borrow your own mini, so there's nothing to book.
  it('offers the owner no booking form', async () => {
    mockApi(EMPTY);
    render(<BookingPanel miniId={42} isOwn />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByLabelText(/^from$/i)).not.toBeInTheDocument();
  });

  it('marks a booking that has already become a request', async () => {
    mockApi({
      max: 10,
      bookings: [{ id: 7, startsOn: day(0), endsOn: day(2), holderName: 'You', note: null, mine: true, started: true }],
    });
    render(<BookingPanel miniId={42} isOwn={false} />);

    expect(await screen.findByText(/now a request/i)).toBeInTheDocument();
  });

  it('stays out of the way if the calendar can\'t be loaded', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Server error' }, { ok: false }));
    render(<BookingPanel miniId={42} isOwn={false} />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole('list', { name: /booked days/i })).not.toBeInTheDocument();
  });
});
