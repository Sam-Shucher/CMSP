import React, { useCallback, useEffect, useState } from 'react';
import { api, CalendarEntry, MiniBookings } from '../api/client';
import { LIMITS } from '../limits';

// "I need this for game night on the 14th." The hold line (HoldPanel) answers
// "tell me when it's free" — this claims particular days. While the mini is out
// (lent, or on a quest with its owner) that's only from the day after it's due
// back, and the panel says so before anyone picks a date.
//
// Which days are claimed is shown to everyone, because that's what makes a
// calendar usable; who claimed them is shown only to the owner and the person
// themselves, the same rule the hold line follows.

const DAY_MS = 24 * 60 * 60 * 1000;

// A day on this device's calendar, which is the group's (everyone is in one
// city) — not UTC's, which is already tomorrow on a Chicago evening.
function isoDay(offsetDays: number): string {
  const day = new Date(Date.now() + offsetDays * DAY_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

function readable(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function span(booking: CalendarEntry): string {
  return booking.startsOn === booking.endsOn
    ? readable(booking.startsOn)
    : `${readable(booking.startsOn)} – ${readable(booking.endsOn)}`;
}

type BookingPanelProps = {
  miniId: number;
  isOwn: boolean;
};

export default function BookingPanel({ miniId, isOwn }: BookingPanelProps): React.ReactElement | null {
  const [calendar, setCalendar] = useState<MiniBookings | null>(null);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const data = await api<Partial<MiniBookings>>(`/api/bookings/minis/${miniId}`);
      setCalendar({
        max: data.max ?? 0,
        bookings: Array.isArray(data.bookings) ? data.bookings : [],
        out: data.out ?? null,
        bookable: data.bookable ?? true,
        earliestStart: data.earliestStart ?? null,
      });
    } catch {
      // The calendar is extra here; the rest of the mini still shows.
    }
  }, [miniId]);

  useEffect(() => { void load(); }, [load]);

  async function book(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError('');
    // A typed date gets past the picker's min; say so here rather than send it.
    const earliestStart = calendar?.earliestStart;
    if (earliestStart && from < earliestStart) {
      setError(`The earliest you can book it is ${readable(earliestStart)} — the day after it's due back.`);
      return;
    }
    setBusy(true);
    try {
      // A single day is booked as itself — the "to" box is for a weekend.
      await api(`/api/bookings/minis/${miniId}`, {
        method: 'POST',
        json: { startsOn: from, endsOn: to || from, note },
      });
      setFrom('');
      setTo('');
      setNote('');
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(bookingId: number): Promise<void> {
    setError('');
    try {
      await api(`/api/bookings/${bookingId}`, { method: 'DELETE' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
    await load();
  }

  if (!calendar) return null;

  // Out on a loan or a quest: bookable from the day after it's due back, or not
  // at all when nobody knows when that is — the hold line above is the way in.
  const earliest = calendar.earliestStart ?? isoDay(0);
  const what = calendar.out?.reason === 'quest' ? 'on a quest with its owner' : 'out on loan';
  const outNotice = calendar.out && !isOwn
    ? (calendar.bookable === false
      ? `It's ${what} with no date it's due back, so it can't be booked yet — place a hold to be next in line.`
      : `It's ${what} until ${readable(calendar.out.until ?? earliest)}. The earliest you can book is ${readable(earliest)}.`)
    : null;

  return (
    <div style={{ marginTop: '12px' }}>
      {outNotice && (
        <p role="note" style={{ fontSize: '12px', color: '#e0a84c', marginBottom: '8px' }}>⚠ {outNotice}</p>
      )}
      {calendar.bookings.length > 0 && (
        <ul aria-label="Booked days" style={{ listStyle: 'none', display: 'grid', gap: '6px', marginBottom: '10px' }}>
          {calendar.bookings.map(booking => (
            <li
              key={booking.id}
              style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', flexWrap: 'wrap' }}
            >
              <span style={{ color: '#c9a84c', fontWeight: 600 }}>{span(booking)}</span>
              <span style={{ color: '#8a7d6a' }}>
                {booking.mine ? 'booked by you' : booking.holderName ? `booked by ${booking.holderName}` : 'booked'}
                {booking.note ? ` · ${booking.note}` : ''}
                {booking.started ? ' · now a request' : ''}
              </span>
              {(booking.mine || isOwn) && !booking.started && (
                <button
                  type="button"
                  className="btn-secondary"
                  aria-label={booking.mine ? 'Cancel this booking' : `Cancel ${booking.holderName}'s booking`}
                  onClick={() => void cancel(booking.id)}
                  style={{ padding: '2px 8px', fontSize: '12px' }}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!isOwn && calendar.bookable !== false && (
        <form noValidate onSubmit={(e: React.FormEvent) => void book(e)} style={{ display: 'grid', gap: '6px' }}>
          <p style={{ fontSize: '12px', color: '#8a7d6a' }}>
            Need it for a particular day? Book it — it becomes a request that morning.
          </p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label htmlFor={`book-${miniId}-from`} style={{ fontSize: '13px', color: '#8a7d6a' }}>From</label>
            <input
              id={`book-${miniId}-from`}
              type="date"
              min={earliest}
              max={isoDay(LIMITS.bookingAheadDays)}
              value={from}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)}
            />
            <label htmlFor={`book-${miniId}-to`} style={{ fontSize: '13px', color: '#8a7d6a' }}>To</label>
            <input
              id={`book-${miniId}-to`}
              type="date"
              min={from || earliest}
              max={isoDay(LIMITS.bookingAheadDays)}
              value={to}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
            />
          </div>
          <label htmlFor={`book-${miniId}-note`} style={{ fontSize: '13px', color: '#8a7d6a' }}>What for</label>
          <input
            id={`book-${miniId}-note`}
            type="text"
            maxLength={LIMITS.bookingNote}
            placeholder="e.g. game night at the shop"
            value={note}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNote(e.target.value)}
          />
          <button
            type="submit"
            className="btn-secondary"
            disabled={busy || !from}
            style={{ justifySelf: 'start', padding: '6px 14px', fontSize: '13px' }}
          >
            Book these days
          </button>
        </form>
      )}

      {error && <div className="error-msg" style={{ marginTop: '8px' }}>{error}</div>}
    </div>
  );
}
