// The limits the server enforces, in one place so a form and the server can't
// drift apart. Each one mirrors a value in the backend:
//   LIMITS            → backend/src/utils/inputs.ts
//   MAX_DURATION_DAYS → backend/src/utils/loanRules.ts
//   MAX_IMAGES, MAX_PHOTO_BYTES, MAX_PRICE → backend/src/routes/minis.ts
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
} as const;

// How often the pages that show other people's activity check for changes.
export const POLL_MS = {
  notifications: 60 * 1000, // the bell
  cart: 60 * 1000,          // the count on the Cart link
  loans: 30 * 1000,         // the Loans page
  clockTick: 60 * 1000,     // re-render "5m ago" and "2d left" labels
} as const;
