import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// public/sw.js is plain JavaScript served as-is, so nothing else in the suite
// reaches it. It's what actually puts a notice on a phone, and what a tap on
// one opens — so it runs here against a stand-in for the worker's `self`.

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'https://minis.example.com';

type Listener = (event: unknown) => void;

function tab(url: string) {
  return {
    url,
    focus: vi.fn<() => Promise<void>>(async () => {}),
    navigate: vi.fn<(url: string) => Promise<void>>(async () => {}),
    postMessage: vi.fn<(message: unknown) => void>(),
  };
}
type FakeTab = ReturnType<typeof tab>;

function loadWorker(tabs: FakeTab[] = []) {
  const listeners: Record<string, Listener> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => { listeners[type] = fn; },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn<(title: string, options: Record<string, unknown>) => Promise<void>>(async () => {}) },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async () => tabs),
      openWindow: vi.fn<(url: string) => Promise<null>>(async () => null),
    },
  };
  // Runs the worker's own file with `self` as its global — the only way to
  // exercise a script the app serves as-is rather than imports.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', SOURCE)(self);

  // Fires an event and waits for whatever it handed to waitUntil.
  async function fire(type: string, event: Record<string, unknown>): Promise<void> {
    let pending: Promise<unknown> = Promise.resolve();
    listeners[type]({ ...event, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
  }

  function push(data: unknown): Promise<void> {
    const payload = data === undefined ? null : {
      json: (): unknown => (typeof data === 'string' ? JSON.parse(data) as unknown : data),
    };
    return fire('push', { data: payload });
  }

  function tap(data: unknown) {
    const notification = { data, close: vi.fn() };
    return { notification, done: fire('notificationclick', { notification }) };
  }

  return { self, listeners, push, tap };
}

describe('the service worker', () => {
  it('caches nothing and handles no fetches, so a phone never runs a stale copy of the site', () => {
    const { listeners } = loadWorker();

    expect(Object.keys(listeners).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
  });
});

describe('the service worker — a push arriving', () => {
  it('shows the notice the server sent, pointing at the page it names', async () => {
    const { self, push } = loadWorker();

    await push({ title: 'Mini Library · Chicago', body: 'Bob requested Dire Wolf', url: '/loans' });

    expect(self.registration.showNotification).toHaveBeenCalledWith('Mini Library · Chicago', expect.objectContaining({
      body: 'Bob requested Dire Wolf',
      data: { url: '/loans' },
    }));
  });

  // A loan's messages share a tag, so a newer one replaces the older one on
  // the phone the way it does in the bell — but still buzzes.
  it('replaces an earlier notice with the same tag, and still alerts', async () => {
    const { self, push } = loadWorker();

    await push({ title: 'Mini Library', body: 'Bob: running late', url: '/loans', tag: 'loan-7-messages' });

    expect(self.registration.showNotification).toHaveBeenCalledWith('Mini Library', expect.objectContaining({
      tag: 'loan-7-messages', renotify: true,
    }));
  });

  it('leaves an untagged notice untagged, so one never hides another', async () => {
    const { self, push } = loadWorker();

    await push({ title: 'Mini Library', body: 'Bob requested Dire Wolf', url: '/loans' });

    const [, options] = self.registration.showNotification.mock.calls[0];
    expect(options).not.toHaveProperty('tag');
    expect(options).not.toHaveProperty('renotify');
  });

  it('still shows something for a push with no payload, or one that isn\'t JSON', async () => {
    const empty = loadWorker();
    await empty.push(undefined);
    expect(empty.self.registration.showNotification).toHaveBeenCalledWith('Mini Library', expect.objectContaining({
      body: expect.any(String), data: { url: '/' },
    }));

    const garbled = loadWorker();
    await garbled.push('not json {');
    expect(garbled.self.registration.showNotification).toHaveBeenCalledWith('Mini Library', expect.anything());
  });

  // The worker opens this URL on a tap; only a path on this site will do.
  // "//host" and "/\host" both start with a slash, but a browser reads each as
  // another site entirely.
  it.each([
    'https://evil.example.com/phish',
    '//evil.example.com/phish',
    '/\\evil.example.com/phish',
    'javascript:alert(1)',
  ])('ignores a link that isn\'t a path on this site (%s)', async (url) => {
    const { self, push } = loadWorker();

    await push({ title: 'Mini Library', body: 'x', url });

    expect(self.registration.showNotification).toHaveBeenCalledWith('Mini Library', expect.objectContaining({
      data: { url: '/' },
    }));
  });

  // src/push.ts's listenForPushes() listens for exactly this message.
  it('tells every open tab, so its bell and Loans page refresh straight away', async () => {
    const tabs = [tab(`${ORIGIN}/`), tab(`${ORIGIN}/loans`)];
    const { push } = loadWorker(tabs);

    await push({ title: 'Mini Library', body: 'x', url: '/loans' });

    for (const t of tabs) expect(t.postMessage).toHaveBeenCalledWith({ type: 'mini-library:push' });
  });
});

describe('the service worker — tapping a notice', () => {
  it('opens the app at the notice\'s page when no tab is open', async () => {
    const { self, tap } = loadWorker([]);

    const { notification, done } = tap({ url: '/loans' });
    await done;

    expect(notification.close).toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/loans`);
  });

  it('brings an open tab forward and takes it to the page, rather than opening another', async () => {
    const open = tab(`${ORIGIN}/`);
    const { self, tap } = loadWorker([open]);

    await tap({ url: '/loans' }).done;

    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith(`${ORIGIN}/loans`);
    expect(self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('just focuses a tab already on that page', async () => {
    const open = tab(`${ORIGIN}/loans`);
    const { tap } = loadWorker([open]);

    await tap({ url: '/loans' }).done;

    expect(open.focus).toHaveBeenCalled();
    expect(open.navigate).not.toHaveBeenCalled();
  });

  it('never steers a tab from some other site', async () => {
    const elsewhere = tab('https://other.example.com/');
    const { self, tap } = loadWorker([elsewhere]);

    await tap({ url: '/loans' }).done;

    expect(elsewhere.focus).not.toHaveBeenCalled();
    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/loans`);
  });

  it('opens the home page for a notice with no link', async () => {
    const { self, tap } = loadWorker([]);

    await tap(undefined).done;

    expect(self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});
