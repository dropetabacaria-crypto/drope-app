// Service Worker SÓ do painel da loja (escopo /filial) — 28/09/2026.
// Antes o painel usava o sw.js do app dos clientes (escopo /): no Android o aviso de pedido
// aparecia como se fosse do app "DROPE" (de comprar) e, sem aquele SW ativo, o botão travava.
// Aqui: só avisos (push) e o clique no aviso. Sem cache — o painel sempre busca da rede.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { title: 'DROPE Loja', body: e.data ? e.data.text() : '' }; }
  const jobs = [self.registration.showNotification(data.title || 'DROPE Loja ✦ novo pedido', {
    body: data.body || '',
    icon: '/icons/app-lojista-192.png',
    badge: '/icons/app-lojista-192.png',
    vibrate: [300, 120, 300, 120, 300],
    tag: 'drope-loja-pedido',
    renotify: true,
    requireInteraction: true, // fica na tela até você tocar — pedido não passa batido
    data: { url: data.url || '/filial' },
  })];
  if (typeof data.badge === 'number' && self.navigator && 'setAppBadge' in self.navigator) {
    jobs.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  e.waitUntil(Promise.all(jobs.map((p) => Promise.resolve(p).catch(() => {}))));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/filial';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cls) => {
    for (const c of cls) {
      let path = '/'; try { path = new URL(c.url).pathname; } catch (_) {}
      if (path.indexOf('/filial') === 0 && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
