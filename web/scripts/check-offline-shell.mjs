// Runs the built service worker against dist/ to prove an installed owner app
// can reload offline: install it online, cut the network, then request the
// navigation, worker, WASM, fonts, favicon, and lazily loaded chunks the way a
// browser would. A browser run of the same path is still worth doing by hand;
// this guards the cache contract on every build.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { registerOfflineShell } from "../src/offline.ts";

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const ORIGIN = "https://researchpocket.github.io";
const failures = [];

// Exercise the application's registration rather than assuming a scope in this
// harness. A worker script is its own client: an /app/-only registration cannot
// intercept a worker under /assets/, even if CacheStorage contains its bytes.
let registrationScope;
const retired = { scope: `${ORIGIN}/app/`, unregister: async () => true };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
  serviceWorker: {
    getRegistrations: async () => [retired],
    register: async (script, options) => {
      registrationScope = new URL(options.scope, script).href;
      return { active: { state: "activated" } };
    },
  },
} });
globalThis.document = { baseURI: `${ORIGIN}/app/` };
globalThis.window = { location: new URL(ORIGIN) };
await registerOfflineShell();

function fileResponse(url) {
  const { pathname } = new URL(url);
  const relative = pathname.replace(/^\//, "") || "index.html";
  const path = resolve(distRoot, relative.endsWith("/") ? `${relative}index.html` : relative);
  try {
    return new Response(readFileSync(path), { status: 200 });
  } catch {
    return new Response("missing", { status: 404 });
  }
}

let online = true;
const network = [];
async function fakeFetch(input) {
  const url = typeof input === "string" ? input : input.url;
  network.push(url);
  if (!online) throw new TypeError("Failed to fetch");
  return fileResponse(url);
}

const store = new Map();
const key = (request) => request instanceof URL ? request.href : typeof request === "string" ? request : request.url;
const cache = {
  async put(request, response) {
    store.set(key(request), response.clone());
  },
  async match(request) {
    return store.get(key(request))?.clone();
  },
  async addAll(urls) {
    for (const url of urls) {
      const response = await fakeFetch(url);
      if (!response.ok) throw new Error(`Precache failed for ${url}`);
      store.set(url, response);
    }
  },
};

const listeners = {};
const self = {
  location: new URL(`${ORIGIN}/sw.js`),
  registration: { scope: registrationScope },
  clients: { claim: async () => undefined },
  skipWaiting: async () => undefined,
  addEventListener: (type, listener) => {
    listeners[type] = listener;
  },
};
const context = vm.createContext({
  self,
  caches: {
    open: async () => cache,
    match: (request) => cache.match(request),
    keys: async () => [],
    delete: async () => true,
  },
  fetch: fakeFetch,
  Request: class extends Request {
    constructor(input, init = {}) {
      super(input, { ...init, cache: undefined });
    }
  },
  Response,
  URL,
  Set,
  Promise,
  Error,
  TypeError,
});
vm.runInContext(readFileSync(resolve(distRoot, "sw.js"), "utf8"), context);

/** @type {Promise<unknown> | undefined} */
let installed;
listeners.install({ waitUntil: (promise) => (installed = promise) });
await installed;

online = false;
const assets = readdirSync(resolve(distRoot, "assets"));
const pick = (pattern) => assets.find((file) => pattern.test(file));
const requests = [
  { path: "app/", destination: "document", mode: "navigate" },
  { path: "favicon.png", destination: "image" },
  { path: `assets/${pick(/^app-.*\.js$/)}`, destination: "script" },
  { path: `assets/${pick(/^app-.*\.css$/)}`, destination: "style" },
  { path: `assets/${pick(/^MarkdownDocument-.*\.js$/)}`, destination: "script" },
  { path: `assets/${pick(/^domain\.worker-.*\.js$/)}`, destination: "worker" },
  { path: `assets/${pick(/\.wasm$/)}`, destination: "" },
  { path: `assets/${pick(/^TX-02-Regular-.*\.woff2$/)}`, destination: "font" },
  { path: "manifest.webmanifest", destination: "manifest" },
];

for (const { path, destination, mode = "same-origin" } of requests) {
  if (path.includes("undefined")) {
    failures.push(`Expected build output for ${destination || "wasm"} is missing`);
    continue;
  }
  const url = `${ORIGIN}/${path}`;
  const clientUrl = destination === "" ? `${ORIGIN}/assets/${pick(/^domain\.worker-.*\.js$/)}` : url;
  if ((mode === "navigate" || destination === "worker" || destination === "") && !clientUrl.startsWith(registrationScope)) {
    failures.push(`Offline ${path} is outside the registered service-worker scope ${registrationScope}`);
    continue;
  }
  const request = { url, method: "GET", destination, mode, headers: new Headers() };
  /** @type {Promise<Response> | null} */
  let responded = null;
  listeners.fetch({ request, respondWith: (promise) => (responded = promise) });
  if (!responded) {
    failures.push(`Offline ${path} bypassed the service worker`);
    continue;
  }
  try {
    const response = await responded;
    if (!response || !response.ok) failures.push(`Offline ${path} was not served from the shell cache`);
  } catch {
    failures.push(`Offline ${path} failed`);
  }
}

for (const path of ["app", "ResearchPocket/app", "ResearchPocket/app/", "ResearchPocket/app/index.html"]) {
  const url = `${ORIGIN}/${path}?launch=homescreen`;
  let response;
  if (!url.startsWith(registrationScope)) {
    failures.push(`Installed launch ${path} is outside the service-worker scope`);
    continue;
  }
  listeners.fetch({
    request: { url, method: "GET", destination: "document", mode: "navigate", headers: new Headers() },
    respondWith: (promise) => (response = promise),
  });
  const redirect = await response;
  if (redirect?.headers.get("Location") !== `${ORIGIN}/app/?launch=homescreen`) {
    failures.push(`Installed launch ${path} did not redirect to the offline owner entry`);
  }
}

// Broad registration must not broaden storage: neither public pages, unrelated
// same-origin responses, authorization requests, nor GitHub data may be cached.
online = true;
const before = new Set(store.keys());
for (const [path, destination, mode, headers = new Headers()] of [
  ["docs/", "document", "navigate"],
  ["index.html", "document", "navigate"],
  ["assets/unrelated.js", "script", "same-origin"],
  ["assets/private.wasm", "", "same-origin"],
  ["favicon.png?secret=value", "image", "same-origin"],
  ["favicon.png", "image", "same-origin", new Headers({ Authorization: "Bearer private" })],
  ["https://api.github.com/repos/private", "", "same-origin"],
]) {
  let response;
  listeners.fetch({
    request: { url: new URL(path, `${ORIGIN}/`).href, method: "GET", destination, mode, headers },
    respondWith: (promise) => (response = promise),
  });
  if (response) await response;
}
if ([...store.keys()].some((url) => !before.has(url))) {
  failures.push("The offline cache stored a resource outside the owner shell");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Offline shell checks passed for ${requests.length} resources, 4 installed launch routes, and cache exclusions.`);
