import { vi } from 'vitest';

// Photo uploads in unit tests land in a scratch folder (UPLOADS_DIR in
// vitest.config.ts); make sure it exists.
import fs from 'fs';
if (process.env.UPLOADS_DIR) fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

// Unit tests mock the database pool one query at a time. A few modules do
// their own database work alongside a route's main queries — checking the
// session on every request, sending notifications, moving the hold line.
// Rather than thread those queries through every mock sequence, unit tests use
// these stand-ins. Those modules are tested for real elsewhere:
//   db/sessions        → sessions.test.ts (unmocked) + sessions.integration.test.ts
//   db/notifications   → notifications.integration.test.ts
//   services/holds     → holds.integration.test.ts
//   services/loanEvents→ notifications.integration.test.ts
vi.mock('../db/sessions', () => ({
  createSession: vi.fn(async () => 'test-session-id'),
  touchSession: vi.fn(async () => true),
  revokeSession: vi.fn(async () => {}),
  revokeAllSessions: vi.fn(async () => {}),
  purgeEndedSessions: vi.fn(async () => 0),
}));

vi.mock('../db/notifications', () => ({
  notify: vi.fn(async () => {}),
  listNotifications: vi.fn(async () => ({ unread: 0, items: [] })),
  markNotificationRead: vi.fn(async () => true),
  markAllNotificationsRead: vi.fn(async () => {}),
}));

vi.mock('../services/holds', () => ({
  MAX_HOLDS: 3,
  placeHold: vi.fn(async () => ({ ok: true, position: 1 })),
  leaveHold: vi.fn(async () => ({ ok: true })),
  watchMini: vi.fn(async () => ({ ok: true })),
  unwatchMini: vi.fn(async () => ({ ok: true })),
  holdSummary: vi.fn(async () => ({ max: 3, count: 0, position: null, watching: false })),
  listMyHolds: vi.fn(async () => ({ holds: [], watching: [] })),
  promoteNextHold: vi.fn(async () => null),
  dropHoldsInCollection: vi.fn(async () => {}),
  announceMiniRemoved: vi.fn(async () => {}),
  promoteStrandedHolds: vi.fn(async () => 0),
}));

vi.mock('../services/loanEvents', () => ({
  requestCreated: vi.fn(async () => {}),
  termsProposed: vi.fn(async () => {}),
  termsApproved: vi.fn(async () => {}),
  termsAppliedToAll: vi.fn(async () => {}),
  requestCancelled: vi.fn(async () => {}),
  handedOff: vi.fn(async () => {}),
  returned: vi.fn(async () => {}),
  notifyOverdueLoans: vi.fn(async () => 0),
}));
