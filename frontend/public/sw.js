// The service worker: shows phone notifications (Web Push) and opens the app
// when one is tapped. It deliberately does NOT cache pages or handle fetches —
// every visit gets the live site, so a deploy can never leave a phone running
// a stale copy. The payload comes from backend/src/utils/pushSubscription.ts's
// pushNotice(): { title, body, url, tag? }.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take over already-open tabs, so a tapped notice can steer them.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let notice = {};
  try {
    notice = event.data ? event.data.json() : {};
  } catch {
    // Not JSON — still show something rather than nothing.
  }
  const title = typeof notice.title === 'string' ? notice.title : 'Mini Library';
  const options = {
    body: typeof notice.body === 'string' ? notice.body : 'Something changed in your library.',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png', // Android's status bar: white on transparent
    // A path on this site only: "//host" and "/\host" start with a slash too,
    // but a browser reads each as a different site.
    data: { url: typeof notice.url === 'string' && /^\/(?![/\\])/.test(notice.url) ? notice.url : '/' },
  };
  if (typeof notice.tag === 'string') {
    options.tag = notice.tag;
    options.renotify = true; // a replaced message still buzzes
  }

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // An open tab refreshes its bell and loans now, rather than at its next poll.
    const tabs = await self.clients.matchAll({ type: 'window' });
    for (const tab of tabs) tab.postMessage({ type: 'mini-library:push' });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find(t => new URL(t.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      if (tab.url !== url && 'navigate' in tab) await tab.navigate(url).catch(() => {});
      return;
    }
    await self.clients.openWindow(url);
  })());
});
