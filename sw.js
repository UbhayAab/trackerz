// Trackerz service worker.
// 1. App-shell cache for offline static pages.
// 2. Network-first for HTML so deploys propagate fast.
// 3. Stale-while-revalidate for CSS/JS/icons.
// 4. Offline capture queue: POSTs to /__offline-capture__ are saved to
//    IndexedDB and replayed via Background Sync when the SW comes back.

const VERSION = "trackerz-v18-20260705";
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

// Minimal IndexedDB access to the same offline-capture queue the app uses
// (src/services/offline-queue.js) — the SW can't import modules, so the tiny
// open/add pair is duplicated here. Schema must stay in sync: db
// trackerz_offline, store captures, autoIncrement id.
function offlineDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("trackerz_offline", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("captures")) {
        db.createObjectStore("captures", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function offlineEnqueue(row) {
  return offlineDb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction("captures", "readwrite").objectStore("captures").add(row);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Web Share Target: the OS share sheet POSTs multipart data at
  // share-target.html, but GitHub Pages is static (405 on POST). Intercept it
  // here, stash the payload in the offline queue, and redirect to the page —
  // share-target.js drains the queue into a normal capture.
  if (req.method === "POST" && url.pathname.endsWith("/share-target.html")) {
    event.respondWith((async () => {
      try {
        const fd = await req.formData();
        const text = ["title", "text", "url"].map((k) => fd.get(k)).filter(Boolean).join("\n");
        const files = fd.getAll("media")
          .filter((f) => f && typeof f === "object" && typeof f.arrayBuffer === "function")
          .map((f) => ({ name: f.name || "shared", type: f.type || "application/octet-stream", blob: f }));
        if (text || files.length) {
          await offlineEnqueue({ text, files, captureType: "auto", queuedAt: Date.now() });
        }
      } catch { /* fall through — the page still opens */ }
      return Response.redirect("./share-target.html", 303);
    })());
    return;
  }

  if (req.method !== "GET") return; // never cache POST/PUT/DELETE

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

// Web Push from the nightly briefing function. Payload: { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || "" }; }
  const title = payload.title || "Trackerz";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      tag: payload.tag || "trackerz",
      icon: "./icons/icon-192.svg",
      badge: "./icons/icon-192.svg",
      data: { url: payload.url || "./" },
    })
  );
});

// Tapping the notification focuses an open Trackerz tab or opens a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "./";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if ("focus" in w) { await w.focus(); return; }
      }
      await self.clients.openWindow(url);
    })()
  );
});
