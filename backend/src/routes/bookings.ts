import { Router, Response } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { route, idFrom } from '../utils/route';
import { requireCollectionMembership, CollectionRequest } from '../middleware/requireCollectionMembership';
import { placeBooking, cancelBooking, miniCalendar, listMyBookings, BookingFailure } from '../services/bookings';
import { parseBookingWindow } from '../utils/bookingRules';
import { optionalText, LIMITS } from '../utils/inputs';

const router = Router();

// Bookings are scoped to the caller's active collection, like the minis
// themselves. A booking on another collection's mini is a 404, not a 403 —
// nothing about another group is confirmable from here.
router.use(requireAuth, requireCollectionMembership);

// Any id that isn't a positive whole number simply matches no mini.
function miniIdFrom(req: CollectionRequest, res: Response): number | null {
  const id = idFrom(req.params.miniId);
  if (id === null) res.status(404).json({ error: 'Mini not found' });
  return id;
}

function fail(res: Response, failure: BookingFailure): void {
  res.status(failure.status).json({ error: failure.error });
}

// GET /api/bookings — the days you've claimed, and the ones claimed on your minis
router.get('/', route(async (req, res) => {
  res.json(await listMyBookings(req.user!.userId, req.collectionId!));
}));

// GET /api/bookings/minis/:miniId — one mini's calendar, as you're allowed to see it
router.get('/minis/:miniId', route(async (req, res) => {
  const miniId = miniIdFrom(req, res);
  if (miniId === null) return;
  const calendar = await miniCalendar(miniId, req.user!.userId, req.collectionId!);
  if (!calendar) {
    res.status(404).json({ error: 'Mini not found' });
    return;
  }
  res.json(calendar);
}));

// POST /api/bookings/minis/:miniId  { startsOn, endsOn, note? }
// Claim a range of days. A single day is booked as itself (startsOn = endsOn).
router.post('/minis/:miniId', route(async (req, res) => {
  const miniId = miniIdFrom(req, res);
  if (miniId === null) return;

  const body = (req.body ?? {}) as Record<string, unknown>;
  const window = parseBookingWindow(body);
  if (!window.ok) {
    res.status(400).json({ error: window.error });
    return;
  }
  const note = optionalText(body.note, 'Note', LIMITS.bookingNote);
  if (!note.ok) {
    res.status(400).json({ error: note.error });
    return;
  }

  const result = await placeBooking(miniId, req.user!.userId, req.collectionId!, window.value, note.value);
  if (!result.ok) return fail(res, result);
  res.status(201).json({ bookingId: result.bookingId });
}));

// DELETE /api/bookings/:id — the booker drops their own; the mini's owner can
// drop any on their mini, since they're the one who has to hand it over.
router.delete('/:id', route(async (req, res) => {
  const bookingId = idFrom(req.params.id);
  if (bookingId === null) {
    res.status(404).json({ error: 'Booking not found' });
    return;
  }
  const result = await cancelBooking(bookingId, req.user!.userId, req.collectionId!);
  if (!result.ok) return fail(res, result);
  res.json({ message: 'Booking cancelled' });
}));

export default router;
