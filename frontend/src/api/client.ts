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
    // Throw with the server's error message so callers can display it directly
    throw new Error((data as { error: string }).error ?? 'Request failed');
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Shared types used by multiple pages
// ---------------------------------------------------------------------------

// The data attached to the React auth context — mirrors the JWT payload
export type User = {
  userId: number;
  username: string;
  role: string;      // 'user' | 'admin'
};

// One row from GET /api/minis — the shape the backend sends back
export type Mini = {
  id: number;
  name: string;
  description: string | null;
  image_path: string | null;  // e.g. "/uploads/1234-abc.jpg", or null if no photo
  available: boolean;
  owner_name: string;         // display_name of the user who owns this mini
  owner_username: string;
  owner_id: number;
  tags: string[];             // already split by the backend from GROUP_CONCAT
  created_at: string;
};
