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

  const res = await fetch(path, {
    ...options,
    credentials: 'include', // sends the httpOnly auth cookie on every request
    headers: isFormData
      ? (options?.headers ?? {})
      : { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
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
    // Throw with the server's error message so callers can display it directly
    throw new Error(message);
  }

  return data as T;
}

export const SESSION_ENDED_EVENT = 'mini-library:session-ended';

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
  dueAt: string | null;
  returnedAt: string | null;
  createdAt: string;
};
