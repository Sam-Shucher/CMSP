import { test as base, expect, Page, BrowserContext } from '@playwright/test';
import path from 'path';
import { resetData, USERS, AUTH_DIR } from './seed.cjs';

export type Username = keyof typeof USERS;

export const authFile = (username: string): string => path.join(AUTH_DIR, `${username}.json`);

type Fixtures = {
  // Opens a new browser window signed in as that user. Several can be open at once.
  as: (username: Username) => Promise<Page>;
  // A window with nobody signed in.
  guest: () => Promise<Page>;
};

// Problems that should fail any test: uncaught script errors, and anything the
// browser blocked under the site's security rules (Content-Security-Policy).
// Failed requests are left out — tests deliberately trigger refusals (409 etc.).
function watchForPageErrors(page: Page, problems: string[]): void {
  page.on('pageerror', err => problems.push(`Uncaught error: ${err.message}`));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (text.startsWith('Failed to load resource')) return;
    problems.push(`Console error: ${text}`);
  });
}

export const test = base.extend<Fixtures & { cleanData: void }>({
  // Every test starts from the seeded users and nothing else.
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the destructuring to find fixture dependencies; this one has none
  cleanData: [async ({}, use) => {
    await resetData();
    await use();
  }, { auto: true }],

  as: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    const problems: string[] = [];
    await use(async (username: Username) => {
      const context = await browser.newContext({ storageState: authFile(username) });
      contexts.push(context);
      const page = await context.newPage();
      watchForPageErrors(page, problems);
      return page;
    });
    for (const context of contexts) await context.close();
    expect(problems, 'the pages reported errors').toEqual([]);
  },

  guest: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    const problems: string[] = [];
    await use(async () => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      watchForPageErrors(page, problems);
      return page;
    });
    for (const context of contexts) await context.close();
    expect(problems, 'the pages reported errors').toEqual([]);
  },
});

export { expect };

// ---- quick setup through the app's own API, from inside the signed-in page ----
// (Runs in the browser, so it uses that user's real session cookie.)

// Smallest valid PNG — a real image the browser can decode.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export async function createMini(page: Page, name: string, options: { tags?: string; withPhoto?: boolean } = {}): Promise<number> {
  if (!page.url().startsWith('http')) await page.goto('/');
  return page.evaluate(async ({ name, tags, withPhoto, png }) => {
    const form = new FormData();
    form.append('name', name);
    if (tags) form.append('tags', tags);
    if (withPhoto) {
      const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
      form.append('images', new File([bytes], 'photo.png', { type: 'image/png' }));
    }
    const res = await fetch('/api/minis', { method: 'POST', body: form, credentials: 'include' });
    if (!res.ok) throw new Error(`createMini failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { miniId: number }).miniId;
  }, { name, tags: options.tags, withPhoto: options.withPhoto ?? false, png: TINY_PNG_BASE64 });
}

// Calls the API as this signed-in person. Give it the shape you expect back:
//   const { body } = await apiCall<{ status: string }>(page, 'GET', `/api/minis/${id}`);
export async function apiCall<T = unknown>(
  page: Page, method: string, url: string, body?: unknown
): Promise<{ status: number; body: T }> {
  if (!page.url().startsWith('http')) await page.goto('/');
  return page.evaluate(async ({ method, url, body }) => {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
  }, { method, url, body });
}

// Cart + checkout for one mini; returns the new request's loan id.
export async function requestMini(page: Page, miniId: number): Promise<number> {
  await apiCall(page, 'POST', '/api/cart', { miniId });
  const checkout = await apiCall<{ created: { loanId: number }[] }>(page, 'POST', '/api/cart/checkout');
  return checkout.body.created[0].loanId;
}

export const TINY_PNG = Buffer.from(TINY_PNG_BASE64, 'base64');
