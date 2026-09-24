import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { authCookie } from './test/helpers';
import { TEST_JWT_SECRET } from './config';

vi.mock('./db/connection', () => ({
  pool: { execute: vi.fn() },
}));

import { pool } from './db/connection';
import { createApp } from './app';

const execute = pool.execute as unknown as ReturnType<typeof vi.fn>;
const MEMBER = { userId: 7, username: 'member', role: 'user', collectionId: 5 };

// On the Pi, the backend also serves the built React app. React Router owns
// URLs like /loans, so a hard refresh there must get index.html — but API and
// upload URLs must never be swallowed by that fallback.
let distDir: string;
let uploadsDir: string;

beforeAll(() => {
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><div id="root">MINI LIBRARY SPA</div>');
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets', 'app.js'), 'console.log("bundle")');

  // Big enough to clear compression's default 1KB threshold — the small
  // app.js fixture above deliberately isn't, so the two together prove the
  // threshold is real rather than "everything gets gzipped".
  fs.writeFileSync(path.join(distDir, 'assets', 'big.js'), '/* filler so this exceeds the compression threshold */\n' + 'x'.repeat(2000));

  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
  fs.writeFileSync(path.join(uploadsDir, '1700000000-wolf.png'), 'PNGDATA');
});

afterAll(() => {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.rmSync(uploadsDir, { recursive: true, force: true });
});

beforeEach(() => {
  execute.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function productionApp() {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('JWT_SECRET', TEST_JWT_SECRET); // production refuses to run without a strong one
  return createApp({ frontendDist: distDir, uploadsDir });
}

describe('createApp in production', () => {
  it.each(['/', '/loans', '/cart', '/minis/42/edit'])('serves index.html for the client-side route %s', async (url) => {
    const res = await request(productionApp()).get(url);

    expect(res.status).toBe(200);
    expect(res.text).toContain('MINI LIBRARY SPA');
  });

  it('serves built static assets directly', async () => {
    const res = await request(productionApp()).get('/assets/app.js');

    expect(res.status).toBe(200);
    expect(res.text).toContain('bundle');
  });

  it('never answers an unknown API route with the web page', async () => {
    const res = await request(productionApp()).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('MINI LIBRARY SPA');
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('never answers an upload URL with the web page', async () => {
    const res = await request(productionApp()).get('/uploads/missing.png');

    expect(res.text).not.toContain('MINI LIBRARY SPA');
  });

  it('still protects API routes', async () => {
    const res = await request(productionApp()).get('/api/loans');

    expect(res.status).toBe(401);
  });
});

// The app reads every API reply as JSON (api/client.ts). Express's own 404 is
// an HTML "Cannot GET /api/..." page, which the app can't show and which
// echoes the path back.
describe('an API URL nothing answers', () => {
  it.each([
    ['get', '/api/does-not-exist'],
    ['post', '/api/minis-typo'],
    ['delete', '/api/'],
  ] as const)('%s %s is a JSON 404', async (method, url) => {
    const res = await request(createApp())[method](url);

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('is a JSON 404 inside a signed-in router too, after its own checks', async () => {
    execute.mockResolvedValueOnce([[{ role: 'user' }]]); // membership

    const res = await request(createApp()).get('/api/minis/1/no-such-thing').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('caching the built frontend', () => {
  // Vite content-hashes every filename under assets/ — the file changing and
  // the URL changing are the same event, so a repeat visit can skip asking
  // the server entirely.
  it('tells the browser to cache a hashed asset forever', async () => {
    const res = await request(productionApp()).get('/assets/app.js');

    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  // index.html names those hashed files, so it's the one page that must
  // never be served from a stale cache — a phone holding yesterday's
  // index.html after a deploy would ask for a bundle that no longer exists
  // and show a blank page. Checked on both paths that can serve it: the
  // static file directly, and the SPA fallback for a client-side route.
  it.each(['/', '/loans'])('always revalidates index.html, served via %s', async (url) => {
    const res = await request(productionApp()).get(url);

    expect(res.headers['cache-control']).toBe('no-cache');
  });
});

describe('compressing responses', () => {
  it('gzips a response once it clears the size threshold', async () => {
    const res = await request(productionApp()).get('/assets/big.js').set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.text).toContain('filler so this exceeds'); // superagent decodes it transparently
  });

  it('leaves a small response alone — not worth the CPU on a Pi', async () => {
    const res = await request(productionApp()).get('/assets/app.js').set('Accept-Encoding', 'gzip');

    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('createApp in development', () => {
  it('does not serve the web page (Vite does that in dev)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const res = await request(createApp({ frontendDist: distDir, uploadsDir })).get('/loans');

    expect(res.status).toBe(404);
  });
});

describe('uploaded photos', () => {
  it('are not visible to someone who is not logged in, even with the exact URL', async () => {
    const res = await request(productionApp()).get('/uploads/1700000000-wolf.png');

    expect(res.status).toBe(401);
    expect(res.text).not.toContain('PNGDATA');
  });

  it('are not visible to a logged-in user outside the photo\'s collection', async () => {
    execute.mockResolvedValueOnce([[]]);

    const res = await request(productionApp()).get('/uploads/1700000000-wolf.png').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('PNGDATA');
  });

  it('are served to members, locked down so the file can never run as a page', async () => {
    execute.mockResolvedValueOnce([[{ found: 1 }]]);

    const res = await request(productionApp()).get('/uploads/1700000000-wolf.png').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  it.each([
    '/uploads/..%2f..%2fpackage.json',
    '/uploads/%2e%2e/%2e%2e/package.json',
    '/uploads/..%5c..%5cpackage.json',
    '/uploads/%252e%252e%252fpackage.json',
  ])('cannot be used to read other files (%s)', async (url) => {
    const res = await request(productionApp()).get(url).set('Cookie', authCookie(MEMBER));

    expect(res.text).not.toContain('mini-library-backend');
    expect(res.text).not.toContain('"dependencies"');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses dotfiles and odd names in the uploads folder', async () => {
    fs.writeFileSync(path.join(uploadsDir, '.env'), 'JWT_SECRET=leaked');

    const res = await request(productionApp()).get('/uploads/.env').set('Cookie', authCookie(MEMBER));

    expect(res.status).toBe(404);
    expect(res.text).not.toContain('leaked');
  });
});

describe('security headers', () => {
  it.each(['/', '/api/loans'])('are sent on %s', async (url) => {
    const res = await request(productionApp()).get(url);

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY'); // no click-jacking the delete buttons inside a hidden frame
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(res.headers['content-security-policy']).toMatch(/object-src 'none'/);
    expect(res.headers['x-powered-by']).toBeUndefined(); // don't advertise the server stack
  });

  it('allow the fonts the page loads from Google Fonts', async () => {
    const res = await request(productionApp()).get('/');
    const csp = res.headers['content-security-policy'];

    expect(csp).toMatch(/style-src[^;]*https:\/\/fonts\.googleapis\.com/);
    expect(csp).toMatch(/font-src[^;]*https:\/\/fonts\.gstatic\.com/);
    expect(csp).toMatch(/img-src[^;]*blob:/); // photo previews before upload
  });

  it('tell browsers to always use HTTPS in production', async () => {
    const res = await request(productionApp()).get('/');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });
});

describe('cross-site request blocking', () => {
  // Browsers label every request with where it came from. Another website
  // (even a sibling subdomain) must not be able to make a logged-in visitor's
  // browser add emails, delete minis, or change roles.
  it.each(['cross-site', 'same-site'])('rejects a state-changing request marked %s', async (site) => {
    const res = await request(productionApp())
      .post('/api/admin/approved-emails')
      .set('Cookie', authCookie(MEMBER))
      .set('Sec-Fetch-Site', site)
      .send({ email: 'attacker@example.com' });

    expect(res.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['DELETE', 'PATCH', 'PUT'])('covers %s requests too', async (method) => {
    const res = await request(productionApp())[method.toLowerCase() as 'delete' | 'patch' | 'put']('/api/minis/1')
      .set('Cookie', authCookie(MEMBER))
      .set('Sec-Fetch-Site', 'cross-site');

    expect(res.status).toBe(403);
  });

  it('allows requests from the site itself', async () => {
    const res = await request(productionApp())
      .post('/api/auth/logout')
      .set('Sec-Fetch-Site', 'same-origin');

    expect(res.status).toBe(200);
  });

  it('allows plain reads from anywhere (they change nothing)', async () => {
    const res = await request(productionApp()).get('/').set('Sec-Fetch-Site', 'cross-site');

    expect(res.status).toBe(200);
  });
});

describe('error responses', () => {
  it('answers malformed JSON with a plain 400, never a stack trace', async () => {
    const res = await request(productionApp())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": "owner@example.com", "password": ');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body' });
    expect(res.text).not.toMatch(/at .*\.js|node_modules/);
  });

  it('rejects an oversized JSON body', async () => {
    const res = await request(productionApp())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x'.repeat(200_000), password: 'y' }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request too large' });
  });
});
