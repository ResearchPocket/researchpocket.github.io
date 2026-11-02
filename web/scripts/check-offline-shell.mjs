// Runs the built service worker against dist/ to prove an installed owner app
// can reload offline: install it online, cut the network, then request the
// navigation, worker, WASM, fonts, favicon, and lazily loaded chunks the way a
// browser would. A browser run of the same path is still worth doing by hand;
// this guards the cache contract on every build.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const ORIGIN = "https://researchpocket.github.io";
const failures = [];

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
const key = (request) => (typeof request === "string" ? request : request.url);
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
  registration: { scope: `${ORIGIN}/app/` },
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
  { path: `assets/${pick(/^domain\.worker-.*\.js$/)}`, destination: "worker" },
  { path: `assets/${pick(/\.wasm$/)}`, destination: "" },
  { path: `assets/${pick(/^TX-02-Regular-.*\.woff2$/)}`, destination: "font" },
];

for (const { path, destination, mode = "same-origin" } of requests) {
  if (path.includes("undefined")) {
    failures.push(`Expected build output for ${destination || "wasm"} is missing`);
    continue;
  }
  const url = `${ORIGIN}/${path}`;
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

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`Offline shell checks passed for ${requests.length} requests after install.`);
