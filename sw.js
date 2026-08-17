// Service Worker do Drope.
// Estratégia:
//   - HTMLs (navigate): network-first → sempre busca versão nova; cache só se offline.
//     Resolve o problema histórico de "versão velha no cache do Chrome do Xiaomi".
//   - Assets estáticos (.js .css imagens): cache-first com revalidação em background.
//   - /api/*: NUNCA cachear (são dados ao vivo).
const CACHE = 'drope-v11';
// Páginas que NUNCA são cacheadas — sempre busca da rede.
// Inclui receber.html porque o fluxo de scanner muda muito; cache antigo causou travamento.
const NEVER_CACHE = ['/receber.html', '/receber', '/index.html', '/'];
const PRECACHE = [
  '/feedback-bubble.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/drope-avatar.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// ===== Push (notificação no celular, app fechado) =====
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { title: 'DROPE', body: e.data ? e.data.text() : '' }; }
  const title = data.title || 'DROPE ✦ novo pedido';
  const jobs = [self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    tag: 'drope-order',
    renotify: true,
    data: { url: data.url || '/filial' },
  })];
  // Bolinha no ícone do app (app fechado): usa a contagem que veio no push.
  if (typeof data.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    jobs.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  e.waitUntil(Promise.all(jobs.map((p) => Promise.resolve(p).catch(() => {}))));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/filial';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
    for (const c of cls) { if (c.url.includes('/filial') && 'focus' in c) return c.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== location.origin) return;

  // Nunca cachear API (sempre dados ao vivo)
  if (url.pathname.startsWith('/api/')) return;

  // Páginas críticas: network-first (sempre fresh, nunca cache).
  // Inclui TODA navegação (req.mode === 'navigate') — ex: /<slug>/painel, que
  // não termina em .html e, como asset cache-first, servia um index.html velho.
  const path = url.pathname;
  if (req.mode === 'navigate' || NEVER_CACHE.includes(path) || path.endsWith('.html')) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => caches.match(req))
    );
    return;
  }

  // Assets: cache-first, atualiza em background
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
