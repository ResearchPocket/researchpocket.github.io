const LEGACY_PREFIX = "/ResearchPocket";
const LEGACY_CACHES = new Set([
  "research-pocket-shell-v1",
  "research-pocket-shell-v2",
]);
const LEGACY_SCOPES = new Set([
  `${window.location.origin}/ResearchPocket/`,
  `${window.location.origin}/ResearchPocket/app/`,
]);

function destination() {
  const migratedPath = window.location.pathname.startsWith(LEGACY_PREFIX)
    ? window.location.pathname.slice(LEGACY_PREFIX.length)
    : "/";
  const path = migratedPath === "" ? "/" : migratedPath;
  return `${window.location.origin}${path}${window.location.search}${window.location.hash}`;
}

async function removeLegacyShell() {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) => LEGACY_SCOPES.has(registration.scope))
        .map((registration) => registration.unregister()),
    );
  }

  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => LEGACY_CACHES.has(cacheName))
        .map((cacheName) => caches.delete(cacheName)),
    );
  }
}

void removeLegacyShell().finally(() => {
  window.location.replace(destination());
});
