const CACHE_PREFIX = "research-pocket-shell-";
// The build stamps the manifest hash here so every new asset graph installs a
// complete shell, even when this worker's source otherwise stays unchanged.
const CACHE_NAME = `${CACHE_PREFIX}v6-__SHELL_REVISION__`;
const SITE_ROOT = new URL("./", self.location.href);
const ASSET_MANIFEST = new URL("asset-manifest.json", SITE_ROOT);
const APP_SHELL = new URL("app/index.html", SITE_ROOT);
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

function shellFiles(manifest, includeLazy = false) {
  const generatedFiles = new Set();
  const visited = new Set();

  function collectEntry(entryKey) {
    if (visited.has(entryKey)) return;
    visited.add(entryKey);
    const entry = manifest[entryKey];
    if (!entry) {
      throw new Error(`The application shell manifest is missing ${entryKey}.`);
    }
    if (typeof entry.file === "string") generatedFiles.add(entry.file);
    for (const cssFile of entry.css ?? []) generatedFiles.add(cssFile);
    for (const assetFile of entry.assets ?? []) generatedFiles.add(assetFile);
    for (const importedEntry of entry.imports ?? []) collectEntry(importedEntry);
    if (includeLazy) {
      for (const importedEntry of entry.dynamicImports ?? []) collectEntry(importedEntry);
    }
  }

  collectEntry("app/index.html");

  return [...SHELL_FILES, ...generatedFiles].map(
    (file) => new URL(file, SITE_ROOT).href,
  );
}

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME);
  const manifestRequest = new Request(ASSET_MANIFEST, { cache: "reload" });
  const manifestResponse = await fetch(manifestRequest);
  if (!manifestResponse.ok) {
    throw new Error("Could not read the application shell manifest.");
  }

  const manifest = await manifestResponse.clone().json();
  await cache.put(manifestRequest, manifestResponse);
  const shellUrls = shellFiles(manifest);
  await cache.addAll(shellUrls);
  // The domain worker is a separate bundle, so the WASM it loads is absent from
  // the manifest. Read each precached worker for the same-origin modules it
  // names; offline, the worker would otherwise die fetching them.
  await cache.addAll(await workerDependencies(cache, shellUrls));
}

// Root scope is required for /assets/ worker clients and old installed launch
// URLs. It does not grant permission to cache other same-origin pages or data.
let allowedResources;
async function isShellResource(url, cache) {
  if (url.search) return false;
  if (!allowedResources) {
    allowedResources = (async () => {
      const response = await cache.match(ASSET_MANIFEST);
      if (!response) return new Set();
      const files = shellFiles(await response.json(), true);
      return new Set([...files, ...await workerDependencies(cache, files)]);
    })();
  }
  return (await allowedResources).has(url.href);
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

  if (request.mode === "navigate") {
    const oldEntries = [
      "/app",
      "/ResearchPocket/app",
      "/ResearchPocket/app/",
      "/ResearchPocket/app/index.html",
    ];
    if (oldEntries.includes(url.pathname)) {
      event.respondWith(
        Promise.resolve(Response.redirect(new URL(`app/${url.search}`, SITE_ROOT).href)),
      );
      return;
    }
    if (!["/app/", "/app/index.html"].includes(url.pathname)) return;
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          const cache = await caches.open(CACHE_NAME);
          if (response.ok && response.type !== "opaque") {
            await cache.put(APP_SHELL, response.clone());
          }
          return response.ok ? response : (await cache.match(APP_SHELL)) ?? response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(APP_SHELL);
          return cached ?? Response.error();
        }),
    );
    return;
  }

  const isWasm = url.pathname.endsWith(".wasm");
  if (!SHELL_DESTINATIONS.has(request.destination) && !isWasm) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      if (!await isShellResource(url, cache)) return fetch(request);
      const cached = await cache.match(request);
      if (cached) {
        return cached;
      }

      return fetch(request).then(async (response) => {
        if (!response.ok || response.type === "opaque") {
          return response;
        }

        await cache.put(request, response.clone());
        return response;
      });
    }),
  );
});
