# ResearchPocket Engineering Contract

This file applies to the entire `ResearchPocket` repository. It is the canonical
contract for human contributors and coding agents working on V2. A more specific
`AGENTS.md` may add local rules for a subtree, but it must not weaken the product,
sync, privacy, or publication invariants in this file.

## Mission

ResearchPocket is a developer-focused, URL-first, local-first personal library.
It helps one person save, curate, find, move, and deliberately share useful URLs
without surrendering control of the library to a hosted product.

The product must remain:

- usable offline, without an account or a running internet-facing backend;
- private by default and explicit about every published field;
- human-directed: user-authored titles, notes, tags, collections, and ordering
  are canonical;
- portable through documented schemas, CLI output, imports, and exports;
- accessible through the CLI, TUI, local web UI, and an authenticated GitHub
  Pages owner mode; and
- convergent across the owner's devices and browsers without asking the user to
  resolve source-control conflicts.

The primary V2 workflows are capture, curation, search, multi-device sync,
recovery of a new device, authenticated hosted editing, selective publication,
and integration with other tools.

## Non-goals for V2

Do not expand V2 into:

- an AI memory, personal profile, RAG service, or autonomous organizer;
- a multi-user collaboration or real-time team product;
- a general notes/wiki application or a store for standalone notes;
- a webpage archive, file/PDF store, highlighting system, or attachment manager;
- a hosted account service or an application backend that must stay online;
- a native mobile application;
- end-to-end encrypted remote storage or encrypted sharing; or
- silent URL deduplication. Concurrent saves of the same URL remain separate
  items and may be surfaced to the owner for an explicit decision.

Keep seams for future transports and optional enrichment, but do not implement a
deferred capability as part of unrelated work.

## Current Baseline and Target Shape

The shipped binary and workspace are V2-first. The root crate provides the V2
CLI, `crates/research-domain` owns convergence semantics, and
`crates/research-store` owns local persistence and V1 import. Pocket-era source
files and migrations remain only as migration references; their former commands
are not compatibility requirements and are not compiled into the binary. Do not
add new Pocket dependencies or design V2 behavior around the discontinued
service.

V2 consolidates product development in this repository. `my-list` and
`ResearchGarden` are migration references until V2 reaches publishing parity;
new application behavior belongs here.

Evolve toward these dependency boundaries:

```text
crates/
  research-domain/       entities, validation, CRDT semantics, projections
  research-store/        SQLite projection, migrations, FTS, outbox
  research-sync/         protocol envelopes, checkpoints, transport interface
  research-app/          use cases shared by every interface
  research-cli/          CLI binary and machine-readable output
  research-tui/          terminal UI
web/                     Preact/Vite SPA for local and GitHub Pages modes
docs/v2/                 product contract, protocol, threat model, ADRs, roadmap
tests/fixtures/           sanitized V1 import and protocol fixtures
```

The pure domain/protocol implementation is Rust and is compiled to WebAssembly
for the hosted application. Native and WASM clients must use the same validation,
normalization, merge, and publication-projection semantics. UI code calls the
application layer; it does not recreate domain rules.

The target CLI is:

```text
research init
research import <v1|pocket|bookmarks|json|csv> <source>
research add <url>
research capture install
research capture status
research capture uninstall
research edit <item-id>
research delete <item-id>
research restore <item-id>
research list
research search <query>
research ui
research tui
research sync setup github
research sync
research sync status
research doctor
research publish preview <collection>
research publish setup github-pages
```

All data commands support `--format human|json|ndjson`. Machine data goes to
stdout; progress, warnings, and diagnostics go to stderr. Do not change a stable
machine schema without a versioned compatibility plan.

`research ui` exposes a versioned loopback API under `/api/v1`. It binds only to
`127.0.0.1`, disables CORS, validates `Origin`, and requires an unguessable
per-session credential. The API and CLI must call the same application services.

## Data and Sync Invariants

These rules are hard requirements, not implementation suggestions.

### Local state

- SQLite is a local materialized projection and search index. It is rebuildable
  from protocol state and is never the remote synchronization format.
- Never copy, upload, publish, or merge a live/raw SQLite database for sync.
- Canonical item identity is UUIDv7 and is independent of a provider ID or URL.
- A local mutation atomically updates CRDT state, the SQLite projection, and the
  durable outbox. A crash must not leave a visible mutation without its update
  batch or an update batch without its corresponding local projection.
- Metadata retrieval is asynchronous and retryable. A failed or offline fetch
  must never prevent the URL from being saved.
- V1 imports are read-only with respect to the source database, are idempotent,
  and create a new V2 library in the platform data directory. Ignore credentials
  found in a V1 database.

### Browser-to-native capture

- Browser bookmarklets invoke an installed, per-user `researchpocket://capture`
  handler. The handler is an invocation bridge only and must call the same
  atomic application/store mutation as `research add`.
- The capture URI is versioned and append-only. Accept only the exact route,
  allowlisted authored fields, and an absolute HTTP(S) target. Reject unknown,
  malformed, duplicated singleton, or oversized input before mutation.
- Bind the resolved executable and local data directory during installation.
  Never accept a database path, provider, repository coordinate, credential,
  executable option, or shell fragment from the URI.
- Treat every decoded value as data without shell interpolation. Registration
  and unregistration are repeatable, per-user operations and do not require
  administrator access.
- A capture commits locally and queues one normal immutable update. It does not
  fetch metadata, read a GitHub token, run synchronization, or depend on a
  notification succeeding.

### Application-level convergence

- Use the pinned Loro Rust/WASM CRDT implementation for convergence.
- Notes are character-level CRDT text so concurrent edits preserve both users'
  text rather than choosing a whole-field winner.
- Scalar fields use causal registers with a deterministic visible value and
  recoverable immutable revision history.
- Tags and collection membership use add-wins observed-remove sets.
- Delete and restore use explicit lifecycle generations. Concurrent edits remain
  recoverable but cannot accidentally resurrect a deleted item.
- A concurrent public/private visibility decision resolves to private until a
  later explicit edit observes and resolves both states.
- Applying updates is deterministic and idempotent under duplication, delay,
  reordering, partitions, and retries.

### Git is transport, never the conflict resolver

Git and GitHub provide storage, transport, access control, triggering, and an
audit trail. **Git commit topology and Git merge/rebase behavior must never
resolve application conflicts.** In particular:

- Do not ask a user to merge, rebase, choose a branch, edit conflict markers, or
  resolve a non-fast-forward update to reconcile library data.
- Do not encode competing application state as edits to the same tracked file.
- Do not use last-commit-wins, branch order, commit timestamps, GitHub merge
  results, or force-pushes as domain semantics.
- All clients exchange immutable, uniquely addressed CRDT update batches.
  Application state converges by applying those batches through the protocol,
  independent of commit order or history shape.
- Repository races and GitHub `409`/`422` responses are transport failures: pull
  unseen immutable batches, retry with bounded jitter, and preserve the outbox.
  They are never presented as application conflicts.

Store update batches at:

```text
sync/v1/ops/<device-uuid>/<zero-padded-sequence>.json
```

Each envelope includes the protocol version, library ID, device ID, durable
device sequence, causal frontier, creation timestamp, base64 CRDT update, and
payload hash. Never rewrite an operation file. If a target path already exists,
an identical hash is an idempotent success; different content is an integrity
error that must stop sync without discarding local data.

Each installation receives its own device UUID and persists its next sequence
before upload. Create immutable checkpoints after either 1,000 update batches or
10 MiB of unapplied tail data. Checkpoints accelerate bootstrap but do not alter
merge semantics. V2 does not prune update history; secure erasure requires a
documented repository-history rewrite or migration to a new data repository.

Sync must be safe after every local mutation, on application start/exit, through
`research sync`, and through optional platform scheduling. Pull before push,
apply all unseen batches, upload queued unique batches, and pull once more after
a remote race. Never drop queued changes on timeout, rate limit, token expiry,
process interruption, or browser reload.

## Hosted Editing, Privacy, and Publishing

Use separate repositories:

1. A private data repository stores updates, checkpoints, publication policy,
   and a pinned publisher workflow.
2. A public Pages repository stores only the static application shell and
   sanitized publication projections.

The GitHub-hosted owner UI is a required management surface, not read-only. It
persists edits to IndexedDB/outbox before network activity and synchronizes them
as immutable application updates. It pulls on startup, focus, before and after a
push race, and every 60 seconds while visible.

Owner authentication uses a fine-grained, expiring PAT scoped only to the private
data repository with `Contents: read/write`. Keep the token in JavaScript memory
by default; explicit session-only storage may use `sessionStorage`. Never put the
token in `localStorage`, IndexedDB, a URL, logs, analytics, generated output, or a
service-worker cache. The token must not have write access to the Pages repository
that serves the application JavaScript.

Owner mode loads no third-party runtime scripts or analytics. Enforce a self-only
content security policy and limit network connections to the required GitHub API.
Native secrets belong in the OS credential store or a local ignored credential
file, never SQLite, protocol updates, exports, or publication artifacts.

Sync and publication are separate operations. Publishing is an allowlisted,
collection-based projection into the Pages repository. Items and fields are
private unless explicitly selected. Notes are excluded unless a collection
explicitly enables them. Unresolved visibility is private.

The publisher must fail closed if any secret, unselected item, private field,
tombstone, update history, or unintended note appears in HTML, embedded JSON,
JavaScript, source maps, feeds, caches, or other output. Preview and deployed
projection use the same code path. Publication provides static HTML, JSON, RSS,
and JSON Feed; it is not a second editable database.

The wire format, immutable repository layout, retries, checkpoints, and version
negotiation are defined in
[`docs/v2/SYNC_PROTOCOL.md`](docs/v2/SYNC_PROTOCOL.md). The security decisions
and residual risks for these surfaces are defined in
[`docs/v2/THREAT_MODEL.md`](docs/v2/THREAT_MODEL.md). The browser persistence and
static-shell implementation boundary is defined in
[`docs/v2/WEB.md`](docs/v2/WEB.md). Sync, hosted-editor, and publisher changes
must preserve all three contracts.

## Change Workflow

- Every planned V2 change is backed by a real ResearchPocket issue and tracked in
  GitHub Project #2 (`ResearchPocket V2`). Do not use project draft items for
  committed implementation work.
- Issue bodies include Context, Deliverables, Acceptance criteria, Non-goals, and
  Dependencies. Apply the `v2`, area, priority, size, phase, and relationship
  metadata agreed by the project charter.
- Set an issue to **In progress** before repository edits, **In review** when its
  pull request opens, and **Done** only after merge and acceptance verification.
- Use parent/sub-issue and blocked-by relationships for epics and dependencies.
  Do not begin a blocked issue by silently inventing the missing decision.
- Architectural, protocol, security, migration, or compatibility decisions need
  an ADR under `docs/v2/` and must link their issue.
- Keep branches and pull requests focused on one issue or tightly coupled set of
  acceptance criteria. Preserve unrelated user changes and avoid drive-by
  cleanup.
- Pull requests link their issues, explain user-visible and protocol impact, list
  verification performed, and include UI evidence where relevant. Commit subjects
  use the imperative mood and remain concise.
- Schema and protocol changes include forward migration, compatibility behavior,
  fixture updates, and recovery/rollback notes. Never mutate an existing released
  migration or silently reinterpret a released protocol field.
- Treat `my-list` and `ResearchGarden` as deprecated only after the consolidation
  ADR is accepted. Add deprecation notices during alpha; archive them only after
  V2 publishing reaches parity.

## Verification

Run the smallest relevant checks while iterating and the complete applicable set
before review. The current Rust baseline is:

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
cargo audit --deny warnings
cargo build --locked --release
```

Once the V2 workspace and web package land, the repository-wide gates also
include all workspace crates, native/WASM golden tests, and the web package's
locked install, lint, unit test, browser test, and production build commands.
Document the exact commands in the root README and CI rather than relying on
developer-global tooling.

Tests are deliberately sparse and contract-focused. Add a test only when it
protects essential behavior that would be expensive, unsafe, or difficult to
verify manually. Prefer one representative scenario at the highest useful
boundary; do not repeat the same assertion across unit, integration, browser,
and end-to-end layers. Do not add tests for trivial accessors, framework wiring,
or implementation details.

Depending on the risk being changed, choose the smallest relevant scenario from:

- randomized two-to-five-client convergence with reordered, duplicated,
  delayed, and partitioned updates;
- identical native Rust and WASM materialized state and publication output;
- concurrent note, scalar, tag, collection, delete/restore, duplicate-URL, and
  visibility operations;
- transaction interruption, outbox replay, checkpoint bootstrap, and full
  restore from the remote log;
- GitHub timeouts, rate limits, non-fast-forward races, duplicate upload,
  corruption detection, and idempotent retry;
- browser offline/reload recovery and PAT expiry or revocation with no queued
  edit loss;
- V1 import idempotency and authored-field preservation;
- canonical export/import round trips;
- negative scans proving private data is absent from every publication artifact;
- local and hosted web end-to-end tests, TUI interaction tests, and supported
  Linux/macOS/Windows CLI checks.

This is a risk catalog, not a requirement to exercise every item for every
feature. A change should normally add no test unless it establishes or modifies
one of these durable contracts.

## Definition of Done

A change is done only when:

- its acceptance criteria pass and its scope matches the linked issue;
- code follows the boundaries and invariants above without duplicating domain
  logic in an interface or transport;
- migrations and protocol changes are compatible, recoverable, and documented;
- the smallest relevant contract tests pass without duplicating coverage across
  layers;
- user-facing CLI/API/schema and operational documentation are updated;
- no credential, private field, raw database, or unsafe generated artifact is
  introduced;
- the pull request has been reviewed and merged; and
- the linked issue is verified against its acceptance criteria before its
  Project status moves to **Done**.
