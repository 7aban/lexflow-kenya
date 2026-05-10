const CACHE_VERSION = "lexflow-static-v1";
const SAFE_STATIC_CACHE = CACHE_VERSION;

function isDeniedRequest(request, url) {
  if (request.method !== "GET") return true;
  if (request.headers.has("Authorization")) return true;

  const fullUrl = url.href.toLowerCase();
  const pathname = url.pathname.toLowerCase();

  if (fullUrl.includes("token=")) return true;
  if (pathname.startsWith("/api/")) return true;
  if (pathname.includes("/download")) return true;
  if (pathname.includes("/pdf")) return true;
  if (pathname.includes("/blob")) return true;

  return false;
}

function isSafeStaticAsset(url) {
  if (url.origin !== self.location.origin) return false;

  const pathname = url.pathname;

  return (
    pathname.startsWith("/assets/") ||
    pathname === "/manifest.json" ||
    pathname.startsWith("/icons/")
  );
}

function offlineResponse() {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="theme-color" content="#0F1B33" />
  <title>LexFlow Offline</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0A0F1A;
      color: #F8FAFC;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 420px;
      padding: 32px;
      text-align: center;
    }
    .mark {
      width: 64px;
      height: 64px;
      margin: 0 auto 20px;
      border-radius: 18px;
      display: grid;
      place-items: center;
      background: #D4A34A;
      color: #0A0F1A;
      font-weight: 800;
      font-size: 32px;
    }
    h1 {
      margin: 0 0 12px;
      font-size: 24px;
    }
    p {
      margin: 0;
      line-height: 1.6;
      color: #CBD5E1;
    }
  </style>
</head>
<body>
  <main>
    <div class="mark">L</div>
    <h1>LexFlow is offline</h1>
    <p>Reconnect to continue. Protected client, matter, billing, document, and court data is not stored for offline access.</p>
  </main>
</body>
</html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("lexflow-") && key !== SAFE_STATIC_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "LEXFLOW_LOGOUT_CLEAR") {
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith("lexflow-"))
          .map((key) => caches.delete(key))
      )
    );
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (isDeniedRequest(request, url)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => offlineResponse())
    );
    return;
  }

  if (!isSafeStaticAsset(url)) {
    return;
  }

  event.respondWith(
    caches.open(SAFE_STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;

      const response = await fetch(request);

      if (response && response.ok) {
        cache.put(request, response.clone());
      }

      return response;
    })
  );
});
