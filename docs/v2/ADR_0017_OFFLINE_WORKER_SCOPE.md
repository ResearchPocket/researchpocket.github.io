# ADR 0017: Offline worker scope and installed launch compatibility

- Status: accepted
- Date: 2026-11-19
- Issue: [#225](https://github.com/ResearchPocket/researchpocket.github.io/issues/225)
- Amends: the static shell boundary in WEB.md and THREAT_MODEL.md.

## Context

The owner page lives at `/app/`, while Vite emits its dedicated domain worker
under `/assets/`. Worker clients are matched against service-worker scopes by
their own script URL. Precaching the worker and WASM is insufficient when the
registration controls only `/app/`: offline operations fail before the domain
worker can start. The former offline build check called the fetch handler
directly and missed this browser routing requirement. Existing iOS Home Screen
installations may also retain `/ResearchPocket/app/` as their launch URL.

## Decision

Register the existing root `/sw.js` at `/`. Keep the web manifest's stable ID
and `/app/` display scope and start URL. Root registration covers the dedicated
worker and installed legacy launch URLs without relocating build assets or
changing library identity. Retire the old `/app/` and `/ResearchPocket/` worker
registrations only after the replacement activates successfully.

Root control does not expand the cache policy. Handle navigation only for
`/app/` and `/app/index.html`; redirect `/app` and the exact former owner entry
paths to `/app/`, preserving queries and the browser's inherited fragment.
Public landing and documentation navigations use the network normally.

Cache only the owner entry's manifest graph, shell manifest/icon, and its
worker's WASM dependencies. Dynamic owner imports remain eligible for caching
on first use. Other same-origin responses, resource query variants, non-GET
requests, Authorization-bearing requests, and cross-origin traffic remain
outside cache storage. Navigation responses use one canonical shell cache key,
so launch queries never become cache keys. IndexedDB and credentials do not
change; no sync or publication schema changes.

Stamp the built service worker and cache name with the asset manifest's SHA-256
hash. Each changed build graph then triggers installation and a complete
precache, rather than serving newer HTML with an older allowlist and incomplete
dependencies. A failed installation leaves the previous active shell intact.

## Verification and recovery

The existing built-shell contract executes the real registration routine and
checks its scope against navigation and worker-client URLs before dispatching
offline requests. It covers installed legacy launch redirects and negative
cache cases. Headed production-browser verification must also open an existing
library, cold-start a domain operation offline, and preserve queued edits over
reload/reconnect. A physical iOS Home Screen launch remains a device check;
desktop browser emulation cannot establish iOS installation behavior.

Existing installations must open online once after deployment to install the
replacement. No site-data reset or library migration is needed. If the browser
has evicted all application storage, downloading the shell again is necessary;
unsynchronized edits cannot be recovered from remote state. First-ever offline
installation and guarantees against browser storage eviction are non-goals.

Rolling back should retain root registration or place all worker clients within
the registration's scope; reverting only the scope recreates the failure.

## Sources

- [Service worker scope and worker clients](https://web.dev/learn/pwa/service-workers#scope)
- [WebKit worker-load registration matching](https://commits.webkit.org/259031@main)
