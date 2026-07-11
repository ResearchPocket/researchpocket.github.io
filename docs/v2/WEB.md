# ResearchPocket V2 hosted owner application

Status: offline owner foundation; private GitHub browser synchronization is the
next slice

## What works now

The static application in `web/` uses the same pinned Rust/Loro domain core as
the native CLI. It can initialize a browser library and add, search, edit,
favorite, tag, delete, and restore saves without a network connection. The UI
contains no sample library or alternate TypeScript merge rules.

Every local action passes the current canonical snapshot into the WASM domain
boundary. One IndexedDB transaction then commits all of the following, or none
of them:

- the next full Loro snapshot;
- the allowlisted materialized item projection;
- the exact immutable update envelope and receipt;
- one durable outbox row; and
- the next fixed-width device sequence.

The WASM boundary also accepts a set of remote immutable envelopes in one Loro
session and reports any causally deferred indices. That path is ready for the
browser GitHub adapter but is not exposed as owner authentication in this slice.

## Browser persistence

IndexedDB database `researchpocket-v2`, version 1, contains only these stores:

| Store | Contents |
| --- | --- |
| `meta` | Library/device UUIDv7 identities, durable Loro peer ID, next sequence, creation time |
| `state` | Canonical Base64 snapshot and local update time |
| `items` | Rebuildable materialized private items for rendering/search |
| `batches` | Exact accepted immutable envelopes and origin |
| `outbox` | Pending local protocol paths, attempt count, sanitized error category |
| `deferred` | Exact remote envelopes still missing a causal predecessor |
| `remoteObservations` | Protocol path, Git blob identity, observation time |

There is no credential, token, authorization-header, repository secret, or
generic settings store. A fine-grained PAT will remain in JavaScript memory by
default when browser synchronization lands; optional tab-only retention will
use `sessionStorage`, never IndexedDB or `localStorage`.

Writes serialize across tabs with the Web Locks API. Browsers without Web Locks
can read an existing library but fail closed before writing, because an in-tab
queue cannot protect a shared device sequence from another tab. A
`BroadcastChannel` refreshes other open tabs after a committed change. The
canonical IndexedDB transaction remains the authority if a tab crashes or a
WASM result cannot be persisted.

## Static and offline boundary

The application bundles React, IndexedDB helpers, JavaScript, CSS, and the WASM
domain artifact. It loads no third-party runtime script, font, image, analytics,
or error reporter. Production builds omit source maps.

The document CSP allows only same-origin application resources and future
connections to `https://api.github.com`. The service worker handles only GETs
for same-origin shell resources and WASM. It explicitly bypasses all GitHub API
traffic, cross-origin traffic, and non-GET requests, so it cannot cache a token,
private API response, or upload body.

Clearing browser site data deletes this device-local replica. Until the browser
GitHub adapter is connected, browser-only pending changes are not remotely
recoverable. The UI says this explicitly rather than implying a cloud backup.

## Build and Pages deployment

The locked build requires Node.js 22.12 or newer, Rust 1.97, the
`wasm32-unknown-unknown` target, and `wasm-bindgen-cli` 0.2.126:

```sh
cd web
npm ci
npm run build
```

The build compiles `research-domain` to WASM, generates the local JavaScript
bridge, runs strict TypeScript checking, and emits a relative-path static site
to `web/dist/`. The Pages workflow performs the same build and deploys only
that directory from the public ResearchPocket source repository. The future
owner PAT will be scoped to a different private data repository and therefore
cannot modify the application JavaScript it executes.

The complete credential and publication boundary remains in
[THREAT_MODEL.md](./THREAT_MODEL.md), and immutable replay behavior remains in
[SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md).
