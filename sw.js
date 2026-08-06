// Deno service worker.
// 1. App-shell cache for offline static pages.
// 2. Network-first for HTML so deploys propagate fast.
// 3. Stale-while-revalidate for CSS/JS/icons.
// 4. Offline capture queue: POSTs to /__offline-capture__ are saved to
//    IndexedDB and replayed via Background Sync when the SW comes back.
// 5. Jarvis Web Push: shows briefs/nudges sent by the jarvis edge function
//    (payload: { title, body, url }) and focuses/opens the app on tap.
// 6. Precache + cache-first for vendor/: the app's own copy of supabase-js,
//    without which no page module can reach the database offline.

// v20 precaches vendor/. Earlier bumps dropped the caches poisoned by the old
// "cache any response" bug (404/503 HTML frozen in as the offline fallback).
// v21 adds the vendored SheetJS chunks; without a bump the old cache would serve
// a precache list that never contained them.
// BUMP THIS ON EVERY DEPLOY THAT CHANGES THE SHELL. The cache is keyed by it and
// is only purged on activate when it changes, so a stale VERSION serves the old
// precached index.html and src/ indefinitely. It sat at v21 from 2026-07-25 while
// the app changed underneath it for twelve days.
// v23 adds quick-log.html + its module. That page is the target of the manifest
// shortcut, the Android home-screen widget and the Quick Settings tile - the
// three surfaces whose whole promise is "one tap logs water". A shortcut that
// opens a blank offline page is worse than no shortcut, so unlike every other
// page module this one is precached explicitly rather than left to be cached on
// first visit.
const VERSION = "deno-v23-20260806";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./quick-log.html",
  "./src/pages/quick-log.js",
  "./lib/water.mjs",
  "./pages/money.html",
  "./pages/gym.html",
  "./pages/analytics.html",
  "./pages/settings.html",
  "./pages/diagnostics.html",
];

// The vendored supabase-js module graph (see vendor/README.md). Without every
// chunk in the cache the app is a dead shell offline: the library fails to
// load, so no page module gets a database at all. Listed explicitly because
// cache.addAll never discovers an ES module's own imports.
const VENDOR = [
  "./vendor/supabase-js/@supabase/supabase-js@2.74.0/index.mjs",
  "./vendor/supabase-js/@supabase/supabase-js@2.74.0/es2022/supabase-js.mjs",
  "./vendor/supabase-js/@supabase/auth-js@2.74.0/es2022/auth-js.mjs",
  "./vendor/supabase-js/@supabase/functions-js@2.74.0/es2022/functions-js.mjs",
  "./vendor/supabase-js/@supabase/node-fetch@2.6.15/es2022/node-fetch.mjs",
  "./vendor/supabase-js/@supabase/postgrest-js@2.74.0/es2022/postgrest-js.mjs",
  "./vendor/supabase-js/@supabase/realtime-js@2.74.0/es2022/realtime-js.mjs",
  "./vendor/supabase-js/@supabase/storage-js@2.74.0/es2022/storage-js.mjs",
  "./vendor/supabase-js/node/async_hooks.mjs",
  "./vendor/supabase-js/node/buffer.mjs",
  "./vendor/supabase-js/node/events.mjs",
  "./vendor/supabase-js/node/process.mjs",
  "./vendor/supabase-js/node/tty.mjs",
  // SheetJS, for bank statement import. Vendored for the same reason: it used to
  // be a static esm.sh import inside statement-import.js, which the money page
  // pulls in transitively, so a CDN hiccup blanked that entire page.
  "./vendor/xlsx/xlsx@0.18.5/index.mjs",
  "./vendor/xlsx/xlsx@0.18.5/es2022/xlsx.mjs",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // Two separate addAll calls: one bad shell URL must not take the vendored
      // library down with it (addAll is all-or-nothing), and vice versa.
      const results = await Promise.allSettled([cache.addAll(APP_SHELL), cache.addAll(VENDOR)]);
      // A precache miss is not fatal - the network-first handler still works
      // online - but it is exactly why "it worked yesterday, offline it's
      // blank", so it must be visible in the console rather than swallowed.
      for (const r of results) {
        if (r.status === "rejected") console.error("[sw] precache failed:", r.reason);
      }
    })()
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

  // WEB SHARE TARGET. manifest.webmanifest declares share_target with
  // method:"POST", enctype:"multipart/form-data" - so when you share a payment
  // screenshot or a receipt into Deno, Android POSTs it to
  // ./share-target.html. This handler did not exist, so the POST fell straight
  // through to GitHub Pages, which is a static host and answers 405. Sharing
  // anything into the app was dead, and src/pages/share-target.js was written
  // expecting exactly this handler to have stashed the payload for it.
  //
  // A POST body cannot be read by the destination page, so the payload goes into
  // the same IndexedDB queue the offline capture path uses, and we redirect to
  // the receiving page with a GET.
  if (req.method === "POST" && new URL(req.url).pathname.endsWith("/share-target.html")) {
    event.respondWith(handleShareTarget(req));
    return;
  }

  if (req.method !== "GET") return; // never cache POST/PUT/DELETE
  const url = new URL(req.url);

  // Supabase API + storage + functions: pass through, never cache.
  if (/supabase\.co|esm\.sh|cdn\.|fonts\./.test(url.hostname)) return;

  // Vendored library chunks are immutable - the version is in the path, so a
  // new version is a new URL. Serve them from cache first: they are ~220KB
  // across 13 files and network-first would re-fetch all of them, uncached, on
  // every single page load.
  if (url.origin === self.location.origin && url.pathname.includes("/vendor/")) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Network-first for everything (HTML/JS/CSS) so a deploy shows immediately,
  // like a normal website; the cache is only an offline fallback. This kills the
  // "ghost version" problem where a stale cached bundle kept showing after deploy.
  event.respondWith(networkFirst(req));
});

// Store the shared payload, then redirect to the receiving page.
//
// The IndexedDB name/store/record shape MUST match src/services/outbox-store.js
// (trackerz_offline / captures / v2 outbox item) - that is the queue
// share-target.js reads back.
// Redirect happens even on a storage failure, with ?shareerror set, so the user
// lands on a page that can explain itself instead of a browser error.
async function handleShareTarget(req) {
  const dest = new URL("./share-target.html", req.url);
  try {
    const form = await req.formData();
    const text = [form.get("title"), form.get("text"), form.get("url")]
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean)
      .join(" ");
    const files = form.getAll("media").filter((f) => f && typeof f === "object" && "size" in f && f.size > 0);

    if (text || files.length) {
      const now = Date.now();
      // The id IS the idempotency key, minted here and stable across every
      // retry. A fresh id per attempt is what let one purchase become three
      // ledger rows on 2026-07-09.
      const id = (self.crypto?.randomUUID?.() || `cap_${now}_${Math.random().toString(36).slice(2, 10)}`);
      await idbAddCapture({
        id,
        clientKey: id,
        state: "pending",
        attempts: 0,
        createdAt: now,
        nextAttemptAt: now,
        text,
        files: files.map((f) => ({ name: f.name || "shared", type: f.type || "application/octet-stream", blob: f })),
        captureType: "auto",
        ingestionId: null,
        lastError: null,
        lastErrorKind: null,
      });
    }
    return Response.redirect(dest.href, 303);
  } catch (err) {
    dest.searchParams.set("shareerror", String(err?.message || err).slice(0, 200));
    return Response.redirect(dest.href, 303);
  }
}

// Minimal IndexedDB write. The SW cannot import src/ modules, so the schema is
// duplicated here on purpose; tests/share-target.test.mjs asserts the two stay
// in agreement.
function idbAddCapture(record) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("trackerz_offline", 2);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("captures")) {
        // keyPath "id", NOT autoIncrement: the id is a client-generated UUID
        // that doubles as the idempotency key.
        const store = db.createObjectStore("captures", { keyPath: "id" });
        store.createIndex("by_state", "state");
        store.createIndex("by_next", "nextAttemptAt");
      }
    };
    // A page holding v1 open blocks the upgrade. Reject rather than hang: the
    // caller redirects with ?shareerror so the user sees why.
    open.onblocked = () => reject(new Error("idb_blocked"));
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("captures", "readwrite");
      // put, not add: the record carries its own primary key now.
      const add = tx.objectStore("captures").put(record);
      add.onerror = () => reject(add.error);
      tx.oncomplete = () => { db.close(); resolve(add.result); };
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function networkFirst(req) {
  try {
    // no-store: bypass the browser HTTP cache so a freshly-deployed asset always
    // wins (GitHub Pages sets ~10min cache headers that otherwise cause "ghost
    // versions"). The SW cache below is kept purely as the offline fallback.
    const fresh = await fetch(req, { cache: "no-store" });
    // Only ok, non-opaque responses are cacheable. Caching a 404/503 (a
    // mid-deploy Pages blip, or a path that briefly doesn't exist) used to make
    // that error the permanent offline page for the URL until the next version
    // bump - the user would see "offline" on a route that was actually fine.
    if (fresh && fresh.ok && fresh.type !== "opaque") {
      const cache = await caches.open(VERSION);
      cache.put(req, fresh.clone());
      return fresh;
    }
    // A 5xx (a mid-deploy Pages blip) is a transport problem, not the truth
    // about this URL - serve the last good copy if we have one, exactly as we
    // do for a thrown fetch. A 4xx IS the truth, so it passes through.
    if (fresh && fresh.status >= 500) {
      const cached = await caches.match(req);
      if (cached) return cached;
    }
    return fresh;
  } catch {
    const cached = await caches.match(req);
    return cached || new Response("offline", { status: 503, headers: { "content-type": "text/plain" } });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const fresh = await fetch(req);
  if (fresh && fresh.ok && fresh.type !== "opaque") {
    const cache = await caches.open(VERSION);
    cache.put(req, fresh.clone());
  }
  // A throw here rejects the fetch, which is what we want: the importing module
  // then fails loudly and supabase-client.js shows its banner. Never hand back
  // a fake 200.
  return fresh;
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

// Jarvis Web Push → OS notification.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Deno";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "./icons/icon-192.svg",
      badge: "./icons/icon-192.svg",
      tag: data.tag || "jarvis",
      data: { url: data.url || "./" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const win of wins) {
        if ("focus" in win) { await win.focus(); return; }
      }
      await self.clients.openWindow(url);
    })()
  );
});
