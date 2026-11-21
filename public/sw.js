// App shell cached for offline use; the API is network-first with the last good
// response as a fallback, so the app still opens on a dead cell signal.
const SHELL = 'buzz-shell-v6';
const API = 'buzz-api-v1';
const SHELL_FILES = ['/', '/index.html', '/about.html', '/styles.css', '/theme.js', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/favicon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== API).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then((res) => {
      if (res.ok && url.pathname === '/api/home') {
        const copy = res.clone();
        caches.open(API).then((c) => c.put('/api/home', copy));
      }
      return res;
    }).catch(() => caches.match(url.pathname === '/api/home' ? '/api/home' : e.request)));
    return;
  }
  // Shell: stale-while-revalidate.
  e.respondWith(caches.match(e.request).then((cached) => {
    const net = fetch(e.request).then((res) => {
      if (res.ok) caches.open(SHELL).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => cached);
    return cached || net;
  }));
});

// Push: the server sends an empty push; fetch the alert it refers to and show it.
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let a = null;
    try {
      const r = await fetch('/api/push/latest', { cache: 'no-store' });
      a = await r.json();
    } catch { /* offline: fall back to a generic notice */ }
    const title = a?.title || 'Telluride.Buzz alert';
    const body = [a?.sourceLabel, a?.summary].filter(Boolean).join(': ').slice(0, 240) || 'Open Telluride.Buzz for details.';
    await self.registration.showNotification(title, {
      body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: a?.id ? `alert-${a.id}` : 'buzz-alert',
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { w.navigate?.('/'); return w.focus(); } }
    return self.clients.openWindow('/');
  })());
});
