import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api, SESSION_ENDED_EVENT, GROUP_CHANGED_EVENT, setActiveGroup } from './client';

function response(body: unknown, init: { ok?: boolean; statusText?: string; badJson?: boolean } = {}): Response {
  return {
    ok: init.ok ?? true,
    statusText: init.statusText ?? 'OK',
    json: init.badJson ? async () => { throw new SyntaxError('Unexpected token <'); } : async () => body,
  } as Response;
}

describe('api()', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('returns the parsed JSON body on success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response([{ id: 1 }]));

    await expect(api('/api/minis')).resolves.toEqual([{ id: 1 }]);
  });

  it('always sends the auth cookie', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({}));

    await api('/api/minis');

    expect(fetch).toHaveBeenCalledWith('/api/minis', expect.objectContaining({ credentials: 'include' }));
  });

  it('serializes the json option as a JSON body with a JSON content type', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({}));

    await api('/api/cart', { method: 'POST', json: { miniId: 3 } });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"miniId":3}');
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json' });
  });

  it('sends FormData as-is and leaves the content type for the browser to set', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({}));
    const form = new FormData();
    form.append('name', 'Dire Wolf');

    await api('/api/minis', { method: 'POST', body: form });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init?.body).toBe(form);
    expect(init?.headers).not.toHaveProperty('Content-Type');
  });

  it('keeps any extra headers the caller passes', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({}));

    await api('/api/minis', { headers: { 'X-Test': 'yes' } });

    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ 'X-Test': 'yes', 'Content-Type': 'application/json' });
  });

  it('throws the server\'s error message on a failed response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ error: "That mini isn't available right now" }, { ok: false }));

    await expect(api('/api/cart', { method: 'POST', json: { miniId: 3 } })).rejects.toThrow("That mini isn't available right now");
  });

  it('falls back to the HTTP status text when the error response isn\'t JSON (e.g. a proxy error page)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(null, { ok: false, statusText: 'Bad Gateway', badJson: true }));

    await expect(api('/api/minis')).rejects.toThrow('Bad Gateway');
  });

  it('throws a generic message when a failed response has no error field', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ message: 'nope' }, { ok: false }));

    await expect(api('/api/minis')).rejects.toThrow('Request failed');
  });

  it('announces a 401 so the app can send the user back to sign in', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ...response({ error: 'Your session has ended. Please sign in again.' }, { ok: false }), status: 401 });
    const listener = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, listener);

    await expect(api('/api/loans')).rejects.toThrow(/session has ended/);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_ENDED_EVENT, listener);
  });

  it('does not treat a wrong password on the login form as an ended session', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ...response({ error: 'Invalid email or password' }, { ok: false }), status: 401 });
    const listener = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, listener);

    await expect(api('/api/auth/login', { method: 'POST', json: {} })).rejects.toThrow();

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(SESSION_ENDED_EVENT, listener);
  });

  it('does not announce other failures', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ...response({ error: 'Admin access required' }, { ok: false }), status: 403 });
    const listener = vi.fn();
    window.addEventListener(SESSION_ENDED_EVENT, listener);

    await expect(api('/api/admin/users')).rejects.toThrow();

    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(SESSION_ENDED_EVENT, listener);
  });

  it('tells the server which group the page is showing', async () => {
    vi.mocked(fetch).mockResolvedValue(response({}));
    setActiveGroup(5);

    await api('/api/minis');
    await api('/api/minis', { method: 'POST', body: new FormData() });

    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({ 'X-Collection-Id': '5' });
    expect(vi.mocked(fetch).mock.calls[1][1]?.headers).toMatchObject({ 'X-Collection-Id': '5' });

    setActiveGroup(undefined);
    await api('/api/auth/me');
    expect(vi.mocked(fetch).mock.calls[2][1]?.headers).not.toHaveProperty('X-Collection-Id');
  });

  it('announces when the group was switched in another tab', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ...response({ error: 'You switched groups in another tab — this page has been updated to match. Please try again.', code: 'group_changed' }, { ok: false }),
      status: 409,
    });
    const listener = vi.fn();
    window.addEventListener(GROUP_CHANGED_EVENT, listener);

    await expect(api('/api/minis', { method: 'POST', body: new FormData() })).rejects.toThrow(/another tab/);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(GROUP_CHANGED_EVENT, listener);
  });

  it('lets a network failure propagate to the caller', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    await expect(api('/api/minis')).rejects.toThrow('Failed to fetch');
  });
});
