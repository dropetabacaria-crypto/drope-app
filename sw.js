// Service Worker do Drope.
// Estratégia:
//   - HTMLs (navigate): network-first → sempre busca versão nova; cache só se offline.
//     Resolve o problema histórico de "versão velha no cache do Chrome do Xiaomi".
//   - Assets estáticos (.js .css imagens): cache-first com revalidação em background.
//   - /api/*: NUNCA cachear (são dados ao vivo).
const CACHE = 'drope-v7';
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
