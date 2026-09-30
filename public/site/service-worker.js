// Network-Only Strategy: لا تخزين مؤقت للبيانات الحيوية
// كل طلب يذهب مباشرة للإنترنت

self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          return caches.delete(cacheName);
        })
      );
    }).then(() => {
      self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  
  if (request.method !== 'GET') {
    return;
  }

  // Network-Only: جلب من الإنترنت فقط
  event.respondWith(
    fetch(request)
      .then((response) => {
        return response;
      })
      .catch(() => {
        // في حالة فشل الاتصال، نعود للـ cache إن وجد
        return caches.match(request);
      })
  );
});

/* ==========================================================================
   WEB PUSH — استقبال إشعارات المشرف الرئيسي (إضافة، لا تغيّر ما سبق)
   ========================================================================== */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (e) { payload = { title: 'ISCAE 18', body: event.data ? event.data.text() : '' }; }

  const title = payload.title || 'ISCAE 18ème Promotion';
  const options = {
    body: payload.body || '',
    icon: payload.icon || './icon-192.png',
    badge: payload.badge || './favicon-32.png',
    dir: 'auto',
    lang: payload.lang || 'ar',
    tag: payload.tag || ('iscae-notif-' + (payload.id || Date.now())),
    renotify: true,
    requireInteraction: false,
    data: { url: payload.url || './index.html', id: payload.id || null },
    vibrate: [120, 60, 120]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './index.html';

  event.waitUntil((async () => {
    const url = new URL(target, self.registration.scope).href;
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of allClients) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus();
        if ('navigate' in client) { try { await client.navigate(url); } catch (e) {} }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

self.addEventListener('pushsubscriptionchange', (event) => {
  /* المتصفح جدّد الاشتراك: الصفحة تُحدّث الصف في قاعدة البيانات عند الفتح التالي (initNotifications). */
  console.log('[Service Worker] pushsubscriptionchange');
});
