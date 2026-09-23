import { test, expect } from './support/fixtures';

// Feature 14's install half. Playwright can't take a real push from a push
// service, but it can check what "Add to Home Screen" and phone notifications
// both stand on: the manifest, its icons, and a service worker that actually
// registers on the real server (a failed registration is only a console
// warning, so nothing else would notice it breaking).

test('the app can be installed: the manifest and every icon it names are served', async ({ guest }) => {
  const page = await guest();

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  const body = await manifest.json() as { name: string; start_url: string; display: string; icons: { src: string }[] };
  expect(body).toMatchObject({ name: 'Mini Library', start_url: '/', display: 'standalone' });

  for (const icon of [...body.icons.map(i => i.src), '/icons/badge-96.png', '/icons/apple-touch-icon.png']) {
    const res = await page.request.get(icon);
    expect(res.status(), icon).toBe(200);
    expect(res.headers()['content-type'], icon).toContain('image/png');
  }

  await page.goto('/login');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
});

test('the service worker is served as a script, not swallowed by the page fallback', async ({ guest }) => {
  const page = await guest();

  const res = await page.request.get('/sw.js');

  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/javascript/);
  expect(await res.text()).toContain("addEventListener('push'");
});

test('the service worker registers and takes charge of the page', async ({ as }) => {
  const page = await as('olivia');
  await page.goto('/');

  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });

  expect(new URL(scope).pathname).toBe('/');
});
