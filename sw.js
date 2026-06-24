// Trackerz service worker.
// 1. App-shell cache for offline static pages.
// 2. Network-first for HTML so deploys propagate fast.
// 3. Stale-while-revalidate for CSS/JS/icons.
// 4. Offline capture queue: POSTs to /__offline-capture__ are saved to
//    IndexedDB and replayed via Background Sync when the SW comes back.

const VERSION = "trackerz-v10-20260624";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./pages/money.html",
  "./pages/diet.html",
  "./pages/gym.html",
  "./pages/analytics.html",
  "./pages/settings.html",
  "./pages/diagnostics.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(APP_SHELL).catch(() => null))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

function isHtml(req) {
  return req.headers.get("accept")?.includes("text/html");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never cache POST/PUT/DELETE
  const url = new URL(req.url);

  // Supabase API + storage + functions: pass through, never cache.
  if (/supabase\.co|esm\.sh|cdn\.|fonts\./.test(url.hostname)) return;

  // Network-first for everything (HTML/JS/CSS) so a deploy shows immediately,
  // like a normal website; the cache is only an offline fallback. This kills the
  // "ghost version" problem where a stale cached bundle kept showing after deploy.
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    // no-store: bypass the browser HTTP cache so a freshly-deployed asset always
    // wins (GitHub Pages sets ~10min cache headers that otherwise cause "ghost
    // versions"). The SW cache below is kept purely as the offline fallback.
    const fresh = await fetch(req, { cache: "no-store" });
    const cache = await caches.open(VERSION);
    cache.put(req, fresh.clone());
    return fresh;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response("offline", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const fetcher = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await fetcher) || new Response("offline", { status: 503 });
}

// Allow the page to ask the SW to fetch + cache new pages on demand.
self.addEventListener("message", (event) => {
  if (event.data?.type === "prefetch" && Array.isArray(event.data.urls)) {
    event.waitUntil(
      caches.open(VERSION).then((cache) => cache.addAll(event.data.urls).catch(() => null))
    );
  }
});
