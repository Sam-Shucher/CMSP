import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonResponse, urlOf, jsonBodyOf } from './test/apiMock';
import {
  keyBytes, pushAvailability, pushStatus, turnOnPush, turnOffPush, resyncPush, forgetPushOnSignOut, listenForPushes,
} from './push';
import { LOANS_CHANGED_EVENT, NOTIFICATIONS_CHANGED_EVENT } from './api/client';

// jsdom has no service workers, push, or notifications — this stands in for
// a browser that has them, with just enough behavior to watch what push.ts does.

const SERVER_KEY = 'BAECAwQ'; // base64url of bytes 4,1,2,3,4
const OTHER_KEY = 'BAkJCQk';

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => unknown;
  unsubscribe: ReturnType<typeof vi.fn>;
}

function fakeSubscription(endpoint: string, key: string): FakeSubscription {
  return {
    endpoint,
    options: { applicationServerKey: keyBytes(key).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

let current: FakeSubscription | null;
let permission: NotificationPermission;
let requestPermission: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let serverKey: string | null;
let fetchMock: ReturnType<typeof vi.fn>;
let workerListeners: ((event: MessageEvent) => void)[];

function installBrowser({ userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126', standalone = false } = {}): void {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe,
    },
  };
  workerListeners = [];
  vi.stubGlobal('navigator', {
    ...navigator,
    userAgent,
    maxTouchPoints: userAgent.includes('iPhone') ? 5 : 0,
    serviceWorker: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
      addEventListener: (_type: string, fn: (event: MessageEvent) => void) => workerListeners.push(fn),
      removeEventListener: (_type: string, fn: (event: MessageEvent) => void) => {
        workerListeners = workerListeners.filter(l => l !== fn);
      },
    },
  });
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    get permission() { return permission; },
    requestPermission,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: standalone && query.includes('standalone') }));
}

beforeEach(() => {
  current = null;
  permission = 'default';
  serverKey = SERVER_KEY;
  requestPermission = vi.fn(async () => {
    permission = 'granted';
    return permission;
  });
  subscribe = vi.fn(async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/new', SERVER_KEY);
    return current;
  });
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (urlOf(input) === '/api/push/key') return jsonResponse({ publicKey: serverKey });
    return jsonResponse({ message: 'ok' });
  });
  vi.stubGlobal('fetch', fetchMock);
  installBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function calls(method: string, url: string) {
  return fetchMock.mock.calls.filter(([input, init]) => urlOf(input as RequestInfo) === url && (init as RequestInit | undefined)?.method === method);
}

describe('keyBytes', () => {
  it('turns the server\'s base64url key into bytes', () => {
    expect([...keyBytes(SERVER_KEY)]).toEqual([4, 1, 2, 3, 4]);
  });
});

describe('pushAvailability', () => {
  it('is supported in a browser that has push', () => {
    expect(pushAvailability()).toBe('supported');
  });

  // Safari only offers push to a site that's been added to the home screen.
  it('asks an iPhone to add the app to the home screen first', () => {
    installBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1' });
    expect(pushAvailability()).toBe('needs-install');
  });

  it('is supported in the iPhone home-screen app', () => {
    installBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', standalone: true });
    expect(pushAvailability()).toBe('supported');
  });

  it('is unsupported where the browser has no push', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux)', maxTouchPoints: 0 });
    expect(pushAvailability()).toBe('unsupported');
  });
});

describe('pushStatus', () => {
  it('is off before anyone has said yes', async () => {
    expect(await pushStatus()).toBe('off');
  });

  it('is on with permission and a subscription', async () => {
    permission = 'granted';
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/abc', SERVER_KEY);
    expect(await pushStatus()).toBe('on');
  });

  it('is blocked once the browser was told no', async () => {
    permission = 'denied';
    expect(await pushStatus()).toBe('blocked');
  });

  it('says so when the server has no keys', async () => {
    serverKey = null;
    expect(await pushStatus()).toBe('not-set-up');
  });
});

describe('turnOnPush', () => {
  it('asks permission, subscribes with the server\'s key, and sends the subscription', async () => {
    await turnOnPush();

    expect(requestPermission).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: keyBytes(SERVER_KEY) });
    const [[, init]] = calls('POST', '/api/push/subscriptions');
    expect(jsonBodyOf(init as RequestInit)).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/new', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('says what to do when permission is refused, and sends nothing', async () => {
    requestPermission.mockResolvedValue('denied');

    await expect(turnOnPush()).rejects.toThrow(/site settings/);
    expect(subscribe).not.toHaveBeenCalled();
    expect(calls('POST', '/api/push/subscriptions')).toHaveLength(0);
  });

  it('replaces a subscription made with an old server key', async () => {
    const old = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', OTHER_KEY);
    current = old;

    await turnOnPush();

    expect(old.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalled();
  });

  it('refuses when the server isn\'t set up, before prompting', async () => {
    serverKey = null;

    await expect(turnOnPush()).rejects.toThrow(/set up/);
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('turnOffPush', () => {
  it('tells the server and ends the browser\'s subscription', async () => {
    const sub = fakeSubscription('https://fcm.googleapis.com/fcm/send/abc', SERVER_KEY);
    current = sub;

    await turnOffPush();

    const [[, init]] = calls('DELETE', '/api/push/subscriptions');
    expect(jsonBodyOf(init as RequestInit)).toEqual({ endpoint: sub.endpoint });
    expect(sub.unsubscribe).toHaveBeenCalled();
  });
});

describe('forgetPushOnSignOut', () => {
  // Signing out is routine (sessions last a week); switching push back on
  // every time would be a chore. The server just stops sending here.
  it('tells the server, but keeps the browser subscribed for the next sign-in', async () => {
    const sub = fakeSubscription('https://fcm.googleapis.com/fcm/send/abc', SERVER_KEY);
    current = sub;

    await forgetPushOnSignOut();

    expect(calls('DELETE', '/api/push/subscriptions')).toHaveLength(1);
    expect(sub.unsubscribe).not.toHaveBeenCalled();
  });

  it('never throws, so signing out always works', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/abc', SERVER_KEY);
    fetchMock.mockRejectedValue(new TypeError('offline'));

    await expect(forgetPushOnSignOut()).resolves.toBeUndefined();
  });
});

describe('resyncPush', () => {
  it('re-sends an existing subscription for whoever is signed in now', async () => {
    permission = 'granted';
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/abc', SERVER_KEY);

    await resyncPush();

    expect(calls('POST', '/api/push/subscriptions')).toHaveLength(1);
  });

  it('never prompts or subscribes someone who hasn\'t turned it on', async () => {
    await resyncPush();

    expect(requestPermission).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(calls('POST', '/api/push/subscriptions')).toHaveLength(0);
  });

  it('moves a device onto a new server key by itself', async () => {
    permission = 'granted';
    const old = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', OTHER_KEY);
    current = old;

    await resyncPush();

    expect(old.unsubscribe).toHaveBeenCalled();
    const [[, init]] = calls('POST', '/api/push/subscriptions');
    expect(jsonBodyOf(init as RequestInit)).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/new' });
  });

  it('never throws', async () => {
    permission = 'granted';
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/abc', SERVER_KEY);
    fetchMock.mockRejectedValue(new TypeError('offline'));

    await expect(resyncPush()).resolves.toBeUndefined();
  });
});

describe('listenForPushes', () => {
  it('refreshes the bell and the Loans page when a push arrives', () => {
    const heard: string[] = [];
    const record = (e: Event) => heard.push(e.type);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, record);
    window.addEventListener(LOANS_CHANGED_EVENT, record);
    const stop = listenForPushes();

    workerListeners.forEach(l => l(new MessageEvent('message', { data: { type: 'mini-library:push' } })));
    workerListeners.forEach(l => l(new MessageEvent('message', { data: { type: 'something-else' } })));

    expect(heard).toEqual([NOTIFICATIONS_CHANGED_EVENT, LOANS_CHANGED_EVENT]);
    stop();
    expect(workerListeners).toHaveLength(0);
    window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, record);
    window.removeEventListener(LOANS_CHANGED_EVENT, record);
  });
});
