const CACHE_PREFIX = "research-pocket-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v3-root`;
const SITE_ROOT = new URL("../", self.registration.scope);
const ASSET_MANIFEST = new URL("asset-manifest.json", SITE_ROOT);
const SHELL_FILES = ["app/", "app/index.html", "manifest.webmanifest", "favicon.svg"];
const SHELL_DESTINATIONS = new Set([
  "document",
  "manifest",
  "script",
  "style",
  "worker",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    cacheApplicationShell().then(() => self.skipWaiting()),
  );
});

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  const manifestRequest = new Request(ASSET_MANIFEST, { cache: "reload" });
  const manifestResponse = await fetch(manifestRequest);
  if (!manifestResponse.ok) {
    throw new Error("Could not read the application shell manifest.");
  }

  const manifest = await manifestResponse.clone().json();
  const generatedFiles = new Set();
  for (const entry of Object.values(manifest)) {
    if (typeof entry.file === "string") generatedFiles.add(entry.file);
    for (const cssFile of entry.css ?? []) generatedFiles.add(cssFile);
    for (const assetFile of entry.assets ?? []) generatedFiles.add(assetFile);
  }

  await cache.put(manifestRequest, manifestResponse);
  const shellUrls = [...SHELL_FILES, ...generatedFiles].map(
    (file) => new URL(file, SITE_ROOT).href,
  );
  await cache.addAll(shellUrls);
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    request.headers.has("Authorization") ||
    url.hostname === "api.github.com" ||
    url.origin !== self.location.origin
  ) {
    return;
  }

  const isWasm = url.pathname.endsWith(".wasm");
  if (!SHELL_DESTINATIONS.has(request.destination) && !isWasm) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && response.type !== "opaque") {
            const copy = response.clone();
            void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(async () => {
          const cached =
            (await caches.match(request)) ??
            (await caches.match(new URL("app/index.html", SITE_ROOT)));
          return cached ?? Response.error();
        }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        if (!response.ok || response.type === "opaque") {
          return response;
        }

        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      });
    }),
  );
});
