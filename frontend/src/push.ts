import { api, LOANS_CHANGED_EVENT, NOTIFICATIONS_CHANGED_EVENT } from './api/client';

// Phone notifications (Web Push). The service worker (public/sw.js) shows
// them; this file signs a device up and down with the server
// (backend/src/routes/push.ts).
//
// Two layers, on purpose:
//   - the BROWSER's subscription belongs to the device. Only "Turn off" on the
//     Profile page ends it, so signing out and back in — which the 7-day
//     session limit makes routine — doesn't mean switching it on again.
//   - the SERVER's row says whose notices go to it. Signing out removes that,
//     and signing in puts it back (resyncPush), for whoever signed in.

const WORKER_URL = '/sw.js';

export type PushStatus =
  | 'unsupported'   // this browser can't do it at all
  | 'needs-install' // iPhone/iPad: only from the home-screen app
  | 'not-set-up'    // the server has no keys yet
  | 'blocked'       // the person (or the browser) said no; only site settings can undo it
  | 'off'
  | 'on';

function isAppleMobile(): boolean {
  // iPadOS reports itself as a Mac, but a Mac has no touch screen.
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);
}

function isInstalled(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function browserCanPush(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Before asking the server anything: can this browser, here, do it at all?
export function pushAvailability(): 'supported' | 'needs-install' | 'unsupported' {
  // Safari on iPhone only offers push to a site added to the home screen, and
  // doesn't even expose the API until then.
  if (isAppleMobile() && !isInstalled()) return 'needs-install';
  return browserCanPush() ? 'supported' : 'unsupported';
}

// Called once at startup (main.tsx). Failure is quiet: the site works without it.
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register(WORKER_URL).catch((err: unknown) => {
    console.warn('Service worker registration failed:', err);
  });
}

// An open tab hears about a push from the service worker and refreshes the
// bell and the Loans page straight away. Returns the unsubscribe.
export function listenForPushes(): () => void {
  if (!('serviceWorker' in navigator)) return () => {};
  const onMessage = (event: MessageEvent): void => {
    if ((event.data as { type?: unknown } | null)?.type !== 'mini-library:push') return;
    window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
    window.dispatchEvent(new Event(LOANS_CHANGED_EVENT));
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  return () => navigator.serviceWorker.removeEventListener('message', onMessage);
}

// The server's public key arrives as base64url; subscribe() wants the bytes.
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

async function serverKey(): Promise<string | null> {
  return (await api<{ publicKey: string | null }>('/api/push/key')).publicKey;
}

async function workerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(WORKER_URL);
  return navigator.serviceWorker.ready;
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(WORKER_URL);
  return registration ? registration.pushManager.getSubscription() : null;
}

function send(subscription: PushSubscription): Promise<unknown> {
  return api('/api/push/subscriptions', { method: 'POST', json: subscription.toJSON() });
}

// What the Profile page shows for this device.
export async function pushStatus(): Promise<PushStatus> {
  const availability = pushAvailability();
  if (availability !== 'supported') return availability;
  if (!(await serverKey())) return 'not-set-up';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  return (await existingSubscription()) ? 'on' : 'off';
}

// "Turn on", from a tap — browsers only show the permission prompt for one.
// Throws with something to show the person when it can't.
export async function turnOnPush(): Promise<void> {
  if (pushAvailability() !== 'supported') throw new Error('This browser can\'t show notifications from the site.');
  const key = await serverKey();
  if (!key) throw new Error('Phone notifications aren\'t set up on the server yet.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notifications are blocked for this site. Allow them in your browser\'s site settings, then try again.');
  }

  const registration = await workerRegistration();
  const bytes = keyBytes(key);
  let subscription = await registration.pushManager.getSubscription();
  // The server has a new key pair: the old subscription can't be sent to.
  if (subscription && !sameKey(subscription, bytes)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  await send(subscription);
}

// "Turn off" on the Profile page: this device, for good (until turned on again).
export async function turnOffPush(): Promise<void> {
  const subscription = await existingSubscription();
  if (!subscription) return;
  try {
    await api('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: subscription.endpoint } });
  } finally {
    await subscription.unsubscribe();
  }
}

// Signing out: notices stop coming here, but the device stays signed up, so
// the next sign-in (resyncPush) brings them back without asking again.
// Never throws — signing out must work regardless.
export async function forgetPushOnSignOut(): Promise<void> {
  try {
    if (!browserCanPush()) return;
    const subscription = await existingSubscription();
    if (subscription) await api('/api/push/subscriptions', { method: 'DELETE', json: { endpoint: subscription.endpoint } });
  } catch {
    // Signed out anyway; the server forgets a dead device on its own.
  }
}

// On every sign-in and app start: tell the server this device still wants
// notices, for whoever is signed in now. Quiet, never prompts, never throws.
// Also picks up a new server key pair without the person doing anything.
export async function resyncPush(): Promise<void> {
  try {
    if (pushAvailability() !== 'supported' || Notification.permission !== 'granted') return;
    let subscription = await existingSubscription();
    if (!subscription) return;
    const key = await serverKey();
    if (!key) return;
    const bytes = keyBytes(key);
    if (!sameKey(subscription, bytes)) {
      await subscription.unsubscribe();
      const registration = await workerRegistration();
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    }
    await send(subscription);
  } catch {
    // Next start will try again; the Profile page shows the real state.
  }
}
