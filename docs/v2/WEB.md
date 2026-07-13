# ResearchPocket V2 hosted owner application

Status: offline owner editing and private GitHub browser synchronization

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

The application bundles React, IndexedDB helpers, JavaScript, CSS, and the WASM
domain artifact. It loads no third-party runtime script, font, image, analytics,
or error reporter. Production builds omit source maps.

The document CSP allows only same-origin application resources and future
connections to `https://api.github.com`. The service worker handles only GETs
for same-origin shell resources and WASM. It explicitly bypasses all GitHub API
traffic, cross-origin traffic, and non-GET requests, so it cannot cache a token,
private API response, or upload body.

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
bridge, runs strict TypeScript checking, and emits a relative-path static site
to `web/dist/`. The Pages workflow performs the same build and deploys only
that directory from the public ResearchPocket source repository. The owner PAT
is scoped to a different private data repository and therefore cannot modify
the application JavaScript it executes.

The complete credential and publication boundary remains in
[THREAT_MODEL.md](./THREAT_MODEL.md), and immutable replay behavior remains in
[SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md).
