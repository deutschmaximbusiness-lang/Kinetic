// Kinetic Service Worker: macht die App offline nutzbar.
// Bei jedem Update die Versionsnummer erhöhen.
const CACHE = 'kinetic-v50';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './supabase.js', './config.js',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Erst Netzwerk (damit Updates sofort ankommen), offline aus dem Cache.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })   // immer beim Server nachfragen, nicht den Browser-Cache nehmen
      .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

// Push-Erinnerung anzeigen
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kinetic', {
    body: d.body || 'Heute ist Einnahme-Tag.',
    icon: './icon-192.png', badge: './icon-192.png', tag: 'kinetic-dose', renotify: true,
    data: { url: d.url || './?tab=einnahme' }
  }));
});
// Tippen auf die Mitteilung: App öffnen (oder nach vorne holen) und zu Einnahme springen
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.postMessage({ type: 'goto', tab: 'einnahme' }); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
