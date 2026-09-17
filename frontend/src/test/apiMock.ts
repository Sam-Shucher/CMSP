// Shared helpers for tests that stand in for the server. Every page talks to
// the API through fetch, so nearly every test needs these three.

type ResponseInit = { ok?: boolean; status?: number; statusText?: string };

// A fetch Response carrying a JSON body. `ok: false` makes api() throw the
// body's `error`, the same way a real failure does.
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const ok = init.ok ?? true;
  return {
    ok,
    status: init.status ?? (ok ? 200 : 400),
    statusText: init.statusText ?? (ok ? 'OK' : 'Error'),
    json: async () => body,
  } as Response;
}

// fetch's first argument may be a string, a URL, or a Request.
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

// The JSON a request was sent with (undefined for FormData or no body).
export function jsonBodyOf(init?: RequestInit): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
}
