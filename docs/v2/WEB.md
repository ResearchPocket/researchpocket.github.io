# ResearchPocket V2 public site and hosted owner application

Status: public product explainer, offline owner editing, and private GitHub browser synchronization

## What works now

The static Pages build in `web/` has two deliberately separate entries. The
root is an indexable, script-free product explainer. `/app/` is the private owner
application and uses the same pinned Rust/Loro domain core as the native CLI. It
can initialize a browser library and add, search, edit,
favorite, tag, delete, and restore saves without a network connection. The UI
contains no sample library or alternate TypeScript merge rules.

First run offers two explicit paths. Starting locally creates an empty browser
library. Restoring prepares the same empty local shell and opens private sync
before the owner makes a local mutation, allowing the pristine replica to adopt
an existing remote library identity. The public landing page remains reachable
from the owner workspace without clearing browser data.

Every local action passes the current canonical snapshot into the WASM domain
boundary. One IndexedDB transaction then commits all of the following, or none
of them:

- the next full Loro snapshot;
- the allowlisted materialized item projection;
- the exact immutable update envelope and receipt;
- one durable outbox row; and
- the next fixed-width device sequence.

The WASM boundary also accepts a set of remote immutable envelopes in one Loro
session and reports any causally deferred indices. The browser GitHub adapter
discovers exact protocol blobs, validates immutable genesis, applies unseen
envelopes through this boundary, serializes Contents API creates, and pulls once
more after uploads or branch-head races.

## Browser persistence

IndexedDB database `researchpocket-v2`, version 2, contains only these stores:

| Store | Contents |
| --- | --- |
| `meta` | Library/device UUIDv7 identities, durable Loro peer ID, next sequence, creation time |
| `state` | Canonical Base64 snapshot and local update time |
| `items` | Rebuildable materialized private items for rendering/search |
| `batches` | Exact accepted immutable envelopes and origin |
| `outbox` | Pending local protocol paths, attempt count, sanitized error category |
| `deferred` | Exact remote envelopes still missing a causal predecessor |
| `remoteObservations` | Protocol path, Git blob identity, observation time |
| `syncConfig` | Non-secret owner, repository, branch, and sanitized success/error times |

There is no credential, token, authorization-header, repository secret, or
generic settings store. The fine-grained PAT remains in JavaScript memory by
default; explicit tab-only retention uses `sessionStorage`, never IndexedDB or
`localStorage`. Authentication, authorization, protocol-integrity, or
upgrade-required failures immediately forget both token copies while preserving
the durable outbox.

Writes serialize across tabs with the Web Locks API. Browsers without Web Locks
can read an existing library but fail closed before writing, because an in-tab
queue cannot protect a shared device sequence from another tab. A
`BroadcastChannel` refreshes other open tabs after a committed change. The
canonical IndexedDB transaction remains the authority if a tab crashes or a
WASM result cannot be persisted.

## Static and offline boundary

The owner application bundles React, IndexedDB helpers, JavaScript, CSS,
same-origin Berkeley Mono webfonts, and the WASM domain artifact. The public
root loads only the shared first-party CSS and its bundled font files; it does
not initialize IndexedDB, JavaScript, or WASM. Neither entry loads a remote
third-party runtime script, font, image, analytics, or error reporter.
Production builds omit source maps.

The document CSP allows only same-origin application resources and future
connections to `https://api.github.com`. The service worker handles only GETs
from pages controlled beneath `/app/` for same-origin shell resources and WASM.
It explicitly bypasses all GitHub API
traffic, cross-origin traffic, and non-GET requests, so it cannot cache a token,
private API response, or upload body.

The canonical deployment is the organization site at
`https://researchpocket.github.io/`, with owner mode under `/app/`. Noindex
compatibility documents at the former `/ResearchPocket/` paths preserve query
and hash fragments, remove only ResearchPocket's retired worker scopes and
shell cache, and redirect on the same origin. IndexedDB therefore remains the
same local library; the URL migration does not copy or rewrite private state.

Vite development servers generate a fresh nonce when they start and attach it
to development-only injected scripts and styles. This keeps CSS hot reload and
the error overlay usable under CSP without adding `unsafe-inline`. Production
builds contain neither that nonce nor a nonce source; they continue to load only
the external same-origin bundles allowed by the checked-in policy.

Clearing browser site data deletes this device-local replica. Once a successful
private sync has drained the outbox, another pristine browser or CLI device can
restore the library from immutable repository genesis and operations. Unsynced
changes remain only in the current browser, and the UI reports their pending
count rather than implying they are already backed up.

## Owner synchronization lifecycle

The owner supplies `OWNER/REPOSITORY`, an optional branch, and an expiring
fine-grained PAT restricted to that private repository with Contents read/write.
Repository coordinates and sanitized timestamps persist; the PAT follows the
memory/tab-only boundary above. The browser rejects public, archived, disabled,
unavailable, read-only, mismatched-library, malformed, or unsupported remotes
before uploading queued work.

One browser upload loop runs under a Web Lock. A cycle validates immutable
genesis, discovers the Git tree, downloads and applies every unseen operation,
uploads unchanged outbox bytes one at a time, and pulls again. Existing identical
paths acknowledge the outbox; byte-different paths stop as integrity failures.
`409`, `422`, ambiguous transport errors, rate limits, and server failures leave
the exact outbox intact for bounded or later retry. Visible owner tabs request a
cycle after local changes, on startup, focus, network recovery, and every 60
seconds.

An edit form carries the note value it originally displayed. If synchronization
or another tab changes that note before submission, the shared WASM mutation
boundary rejects the stale replacement before creating an envelope; the owner
reopens the form against the merged text instead of overwriting it.

## Build and Pages deployment

The locked build requires Node.js 22.12 or newer, Rust 1.97, the
`wasm32-unknown-unknown` target, and `wasm-bindgen-cli` 0.2.126:

```sh
cd web
npm ci
npm run build
```

The build compiles `research-domain` to WASM, generates the local JavaScript
bridge, runs strict TypeScript and policy checking, and emits the root landing
page plus the relative-path owner app under `web/dist/app/`. The protected
source repository is also the reserved organization Pages repository,
`ResearchPocket/researchpocket.github.io`; its workflow performs the same build
and deploys only `web/dist/`. The former repository URL continues through
GitHub's repository redirect, while the generated compatibility documents own
the former Pages paths. The owner PAT is scoped to a different private data
repository and therefore cannot modify the application JavaScript it executes.

The complete credential and publication boundary remains in
[THREAT_MODEL.md](./THREAT_MODEL.md), and immutable replay behavior remains in
[SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md).
