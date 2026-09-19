// Generic fetch wrapper used by every page in the app.
// It handles JSON serialization, attaches credentials (the auth cookie),
// and throws an Error with the server's message on non-2xx responses.
//
// Usage:
//   const minis = await api<Mini[]>('/api/minis');
//   await api('/api/auth/logout', { method: 'POST' });
//   await api('/api/minis', { method: 'POST', body: formData });  // multipart upload
export async function api<T = unknown>(
  path: string,
  options?: RequestInit & { json?: unknown } // `json` is our shorthand for JSON request bodies
): Promise<T> {
  // If the caller passed a FormData body (file upload), don't set Content-Type —
  // the browser sets it automatically with the correct multipart boundary.
  const isFormData = options?.body instanceof FormData;
  // Which group this page is showing, so the server can refuse if another tab
  // has since switched the session to a different group.
  const groupHeader: Record<string, string> = activeGroup === undefined ? {} : { 'X-Collection-Id': String(activeGroup) };

  const res = await fetch(path, {
    ...options,
    credentials: 'include', // sends the httpOnly auth cookie on every request
    headers: isFormData
      ? { ...groupHeader, ...options.headers }
      : { 'Content-Type': 'application/json', ...groupHeader, ...options?.headers },
    // If `json` was provided, serialize it; otherwise use `body` as-is (FormData or undefined)
    body: options?.json !== undefined ? JSON.stringify(options.json) : options?.body,
  });

  // Always try to parse the response as JSON — our API always returns JSON
  const data: unknown = await res.json().catch(() => ({ error: res.statusText }));

  if (!res.ok) {
    const message = (data as { error?: string }).error ?? 'Request failed';
    // A 401 anywhere except the sign-in forms means the session is over
    // (logged out elsewhere, idle too long, or expired). App listens for this
    // and sends the user back to sign in with an explanation.
    if (res.status === 401 && !SIGN_IN_FORMS.includes(path)) {
      window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: message }));
    }
    // Another tab switched groups; App catches this tab up.
    if ((data as { code?: string }).code === 'group_changed') {
      window.dispatchEvent(new Event(GROUP_CHANGED_EVENT));
    }
    // Throw with the server's error message so callers can display it directly
    throw new Error(message);
  }

  return data as T;
}

export const SESSION_ENDED_EVENT = 'mini-library:session-ended';

// The session's group was switched in another tab of this browser.
export const GROUP_CHANGED_EVENT = 'mini-library:group-changed';

let activeGroup: number | undefined;

// Called by App whenever the group this tab is showing changes.
export function setActiveGroup(collectionId: number | undefined): void {
  activeGroup = collectionId;
}

// Something about your loans or holds may have changed (a notification was
// opened) — the Loans page reloads, even if you're already looking at it.
export const LOANS_CHANGED_EVENT = 'mini-library:loans-changed';

// A mini went into or out of the cart — the count in the nav re-checks, so it
// doesn't sit stale until its next minute-by-minute look.
export const CART_CHANGED_EVENT = 'mini-library:cart-changed';

// Where a 401 just means "wrong email or password", not an ended session.
const SIGN_IN_FORMS = ['/api/auth/login', '/api/auth/register'];

// ---------------------------------------------------------------------------
// Shared types used by multiple pages
// ---------------------------------------------------------------------------

// The data attached to the React auth context — mirrors the JWT payload
export type User = {
  userId: number;
  username: string;
  role: string;      // 'user' | 'admin' — the role in the ACTIVE collection; 'user' until one is chosen
  collectionId?: number; // absent until a collection is selected — see /api/auth/select-collection
  // True when an admin has set a temporary password: the app asks for a new
  // one before anything else.
  mustChangePassword?: boolean;
};

export type CollectionRole = 'user' | 'admin';

// One row from GET /api/auth/collections — the collections the current user
// belongs to, and their role in each.
export type Collection = {
  id: number;
  name: string;
  role?: CollectionRole;
};

// requested = checked out and being negotiated; adventuring = handed off to a
// borrower; on_quest = the owner took it out themselves (e.g. to bring to a game)
export type MiniStatus = 'available' | 'requested' | 'adventuring' | 'on_quest';

// One row from GET /api/minis — the shape the backend sends back
export type Mini = {
  id: number;
  name: string;
  description: string | null;
  images: string[];           // e.g. ["/uploads/1234-abc.jpg"], up to 3, already split by the backend
  price: number;
  status: MiniStatus;
  available: boolean;         // status === 'available'
  on_quest_since?: string | null; // ISO timestamp while on a quest
  on_quest_until?: string | null; // optional "back by" date, YYYY-MM-DD
  owner_name: string;         // display_name of the user who owns this mini
  owner_username: string;
  owner_id: number;
  tags: string[];             // already split by the backend from GROUP_CONCAT
  created_at: string;
};

// One row from GET /api/cart
export type CartItem = {
  miniId: number;
  name: string;
  image: string | null;
  ownerId: number;
  ownerName: string;
  ownerUsername: string;
  status: MiniStatus;
};

// GET /api/holds/minis/:id — the line for one mini. `queue` is only sent to the owner.
export type HoldSummary = {
  max: number;
  count: number;
  position: number | null;
  watching: boolean;
  queue?: { position: number; displayName: string }[];
};

// GET /api/holds — your places in line, and full lines you asked to hear about
export type MyHolds = {
  holds: { miniId: number; miniName: string; miniImage: string | null; ownerName: string; position: number; status: MiniStatus }[];
  watching: { miniId: number; miniName: string; holdCount: number }[];
};

// One entry from GET /api/notifications
export type NotificationItem = {
  id: number;
  type: string;
  message: string;
  miniId: number | null;
  loanId: number | null;
  read: boolean;
  expiresAt: string | null; // when a read notification disappears; null while unread
  createdAt: string;
};

export type LoanStage = 'negotiating' | 'agreed' | 'adventuring' | 'overdue' | 'returned' | 'cancelled';

// One row from GET /api/loans, seen from the current user's side
export type Loan = {
  id: number;
  miniId: number;
  miniName: string;
  miniImage: string | null;
  role: 'borrower' | 'owner';
  counterpart: { id: number; username: string; displayName: string };
  status: 'negotiating' | 'adventuring' | 'returned' | 'cancelled';
  stage: LoanStage;
  handoffWhen: string | null;  // ISO timestamp
  handoffWhere: string | null;
  handoffHow: string | null;
  durationDays: number | null;
  borrowerApproved: boolean;
  ownerApproved: boolean;
  handedOffAt: string | null;
  receivedAt: string | null; // borrower's "Got it", after the handoff
  dueAt: string | null;
  returnedAt: string | null;
  createdAt: string;
};
