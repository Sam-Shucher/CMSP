import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { authCookie } from './test/helpers';
import { resetRateLimits } from './middleware/rateLimit';

vi.mock('./db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from './db/connection';
import { createApp } from './app';

// "What if someone who isn't an admin just types /api/admin/users into their
// browser?" — asked of EVERY endpoint the server actually has. The list below
// is read from the live app, not written by hand, so a route added later
// without the right protection fails this file automatically.

const app = createApp();
const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;

type Endpoint = { method: 'get' | 'post' | 'patch' | 'put' | 'delete'; path: string };

interface Layer {
  name: string;
  regexp: RegExp;
  route?: { path: string; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
}

function mountPath(layer: Layer): string {
  // Express 4 stores a router's mount point only as a regexp like ^\/api\/auth\/?(?=\/|$)
  return layer.regexp.source
    .replace('^', '')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/');
}

function listEndpoints(): Endpoint[] {
  const stack = (app as unknown as { _router: { stack: Layer[] } })._router.stack;
  const endpoints: Endpoint[] = [];
  for (const layer of stack) {
    if (layer.name !== 'router' || !layer.handle.stack) continue;
    const base = mountPath(layer);
    for (const inner of layer.handle.stack) {
      if (!inner.route) continue;
      for (const method of Object.keys(inner.route.methods)) {
        endpoints.push({
          method: method as Endpoint['method'],
          path: `${base}${inner.route.path}`.replace(/:[A-Za-z]+/g, '1'),
        });
      }
    }
  }
  return endpoints;
}

const ALL = listEndpoints();
const label = (e: Endpoint) => `${e.method.toUpperCase()} ${e.path}`;

// The only endpoints anyone may call without being logged in.
const PUBLIC = new Set(['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout']);
const PROTECTED = ALL.filter(e => !PUBLIC.has(label(e)));
const ADMIN_ONLY = ALL.filter(e => e.path.startsWith('/api/admin'));
const COLLECTION_SCOPED = ALL.filter(e => /^\/api\/(minis|cart|loans|admin|holds|notifications)/.test(e.path));

function send(e: Endpoint, cookie?: string) {
  let req = request(app)[e.method](e.path);
  if (cookie) req = req.set('Cookie', cookie);
  return e.method === 'get' || e.method === 'delete' ? req : req.send({});
}

beforeEach(() => {
  execute.mockReset();
  resetRateLimits();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the endpoint list itself', () => {
  it('really was read from the app (so the checks below can\'t silently pass on nothing)', () => {
    expect(ALL.length).toBeGreaterThanOrEqual(25);
    expect(ALL.map(label)).toEqual(expect.arrayContaining([
      'GET /api/admin/users',
      'PATCH /api/admin/users/1/role',
      'DELETE /api/admin/users/1',
      'POST /api/admin/approved-emails',
      'DELETE /api/minis/1',
      'POST /api/loans/1/handoff',
      'POST /api/cart/checkout',
      'POST /api/holds/minis/1',
      'POST /api/notifications/read-all',
    ]));
    expect(ADMIN_ONLY.length).toBeGreaterThanOrEqual(6);
  });
});

describe('not logged in', () => {
  it.each(PROTECTED.map(e => [label(e), e] as const))('%s → 401, touching nothing', async (_l, e) => {
    const res = await send(e);

    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('forged login cookie (signed with a guessed secret, claiming admin)', () => {
  const forged = `token=${jwt.sign({ userId: 1, username: 'boss', role: 'admin', collectionId: 5 }, 'change-me-in-production')}`;

  it.each(PROTECTED.map(e => [label(e), e] as const))('%s → 401, touching nothing', async (_l, e) => {
    const res = await send(e, forged);

    expect(res.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('a logged-in member who is not an admin', () => {
  const member = authCookie({ userId: 2, username: 'grunt', role: 'user', collectionId: 5 });

  it.each(ADMIN_ONLY.map(e => [label(e), e] as const))('%s → 403, after only the membership check', async (_l, e) => {
    execute.mockResolvedValueOnce([[{ role: 'user' }]]);

    const res = await send(e, member);

    expect(res.status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(ADMIN_ONLY.map(e => [label(e), e] as const))('%s → 403 even with a cookie edited to say "admin"', async (_l, e) => {
    execute.mockResolvedValueOnce([[{ role: 'user' }]]);

    const res = await send(e, authCookie({ userId: 2, username: 'grunt', role: 'admin', collectionId: 5 }));

    expect(res.status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('someone who is not a member of the collection in their cookie', () => {
  const outsider = authCookie({ userId: 9, username: 'outsider', role: 'admin', collectionId: 5 });

  it.each(COLLECTION_SCOPED.map(e => [label(e), e] as const))('%s → 403, even as a site admin', async (_l, e) => {
    execute.mockResolvedValueOnce([[]]);

    const res = await send(e, outsider);

    expect(res.status).toBe(403);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('logged in but no collection chosen yet', () => {
  const noCollection = authCookie({ userId: 2, username: 'grunt', role: 'user' });

  it.each(COLLECTION_SCOPED.map(e => [label(e), e] as const))('%s → 400, touching nothing', async (_l, e) => {
    const res = await send(e, noCollection);

    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });
});
