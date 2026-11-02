const CACHE_PREFIX = "research-pocket-shell-";
const CACHE_NAME = `${CACHE_PREFIX}v5-root`;
const SITE_ROOT = new URL("../", self.registration.scope);
const ASSET_MANIFEST = new URL("asset-manifest.json", SITE_ROOT);
const SHELL_FILES = ["app/", "app/index.html", "manifest.webmanifest", "favicon.png"];
// Fonts and the favicon are precached too; without their destinations here an
// offline reload bypassed the cache and requested them from the network.
const SHELL_DESTINATIONS = new Set([
  "document",
  "font",
  "image",
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

  function collectEntry(entryKey) {
    const entry = manifest[entryKey];
    if (!entry) {
      throw new Error(`The application shell manifest is missing ${entryKey}.`);
    }
    if (typeof entry.file === "string") generatedFiles.add(entry.file);
    for (const cssFile of entry.css ?? []) generatedFiles.add(cssFile);
    for (const assetFile of entry.assets ?? []) generatedFiles.add(assetFile);
    for (const importedEntry of entry.imports ?? []) collectEntry(importedEntry);
  }

  collectEntry("app/index.html");

  await cache.put(manifestRequest, manifestResponse);
  const shellUrls = [...SHELL_FILES, ...generatedFiles].map(
    (file) => new URL(file, SITE_ROOT).href,
  );
  await cache.addAll(shellUrls);
  // The domain worker is a separate bundle, so the WASM it loads is absent from
  // the manifest. Read each precached worker for the same-origin modules it
  // names; offline, the worker would otherwise die fetching them.
  await cache.addAll(await workerDependencies(cache, shellUrls));
}

async function workerDependencies(cache, shellUrls) {
  const dependencies = new Set();
  for (const url of shellUrls) {
    if (!/\.worker-[\w-]+\.js$/.test(url)) continue;
    const response = await cache.match(url);
    const source = response ? await response.text() : "";
    for (const [name] of source.matchAll(/[\w-]+\.wasm\b/g)) {
      const dependency = new URL(name, url);
      if (dependency.origin === self.location.origin) dependencies.add(dependency.href);
    }
  }
  return [...dependencies];
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
