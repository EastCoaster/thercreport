const CACHE_NAME = 'rc-program-v2';
const APP_SHELL_ASSETS = [
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './vendor/chart.umd.min.js'
];

// Install event - cache app shell assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] Caching app shell');
        return cache.addAll(APP_SHELL_ASSETS);
      })
      .then(() => {
        console.log('[SW] Install complete');
        return self.skipWaiting();
      })
  );
});

// Activate event - delete old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('[SW] Activation complete');
        return self.clients.claim();
      })
  );
});

// Helper: Check if URL is for app shell asset
function isAppShellAsset(url) {
  const path = new URL(url).pathname;
  return APP_SHELL_ASSETS.some(asset => path.endsWith(asset.replace('./', '')));
}

// Fetch event - cache-first for app shell, network-first for external
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = request.url;

  // Cache-first strategy for app shell assets
  if (isAppShellAsset(url)) {
    event.respondWith(
      caches.match(request)
        .then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // If not in cache, fetch and cache it
          return fetch(request)
            .then((response) => {
              if (response && response.status === 200) {
                const responseToCache = response.clone();
                caches.open(CACHE_NAME)
                  .then((cache) => cache.put(request, responseToCache));
              }
              return response;
            });
        })
    );
  } else {
    // Network-first strategy for external URLs with cache fallback
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Cache successful responses
          if (response && response.status === 200) {
            const responseToCache = response.clone();
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(request, responseToCache));
          }
          return response;
        })
        .catch(() => {
          // Fallback to cache if network fails
          return caches.match(request)
            .then((cachedResponse) => {
              if (cachedResponse) {
                console.log('[SW] Serving from cache (offline):', request.url);
                return cachedResponse;
              }
              throw new Error('No cached response available');
            });
        })
    );
  }
});

// Message event - handle commands from the app
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
