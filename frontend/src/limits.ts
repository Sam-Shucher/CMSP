// The limits the server enforces, in one place so a form and the server can't
// drift apart. Each one mirrors a value in the backend:
//   LIMITS            → backend/src/utils/inputs.ts
//   MAX_DURATION_DAYS → backend/src/utils/loanRules.ts
//   MAX_IMAGES, MAX_PHOTO_BYTES, MAX_PRICE → backend/src/routes/minis.ts
//   MAX_BOOKING_DAYS, MAX_BOOKING_AHEAD_DAYS → backend/src/utils/bookingRules.ts
//   MAX_CONDITION_PHOTOS → backend/src/utils/conditionReports.ts
//   HANDOFF_EARLIEST_MINUTES, HANDOFF_LATEST_MINUTES → backend/src/utils/loanRules.ts
//   PAGE_SIZE.browsePage → BROWSE_PAGE_SIZE in backend/src/routes/minis.ts
//   PAGE_SIZE.loanHistoryPage → LOAN_HISTORY_PAGE_SIZE in backend/src/routes/loans.ts
export const LIMITS = {
  displayName: 100,
  neighborhood: 100,
  miniName: 255,
  description: 5000,
  tag: 50,
  tagsPerMini: 20,
  search: 100,
  price: 9999.99,
  loanDays: 90,          // about three months
  questDays: 90,         // and the same for taking your own mini out
  photosPerMini: 3,
  photoBytes: 10 * 1024 * 1024,
  setName: 100,
  setMembers: 50, // most a single set-membership change can touch at once
  conditionNote: 1000,   // a note about how a mini looked at one end of a loan
  conditionPhotos: 3,    // and how many photos can go with it
  bookingNote: 255,      // "game night at the shop"
  bookingDays: 90,       // a booking can't reserve longer than a loan can run
  bookingAheadDays: 180, // and can't be made further out than that
  loanMessage: 500,      // one message on a loan's thread
  handoffEarliestMinutes: 6 * 60, // a handoff is arranged for 6:00am...
  handoffLatestMinutes: 22 * 60,  // ...to 10:00pm, the group's local time
} as const;

// How often the pages that show other people's activity check for changes.
export const POLL_MS = {
  notifications: 60 * 1000, // the bell
  cart: 60 * 1000,          // the count on the Cart link
  loans: 30 * 1000,         // the Loans page
  clockTick: 60 * 1000,     // re-render "5m ago" and "2d left" labels
} as const;

// How many minis (browse) and finished loans (Loans page history) the server
// sends at a time. A full page means there may be more, so the page offers to
// load the next one; a shorter page is the last.
export const PAGE_SIZE = {
  browsePage: 60,
  loanHistoryPage: 20,
} as const;
