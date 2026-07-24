# ResearchPocket V2 Delivery Roadmap

Status: implementation sequence and release gates for V2

This roadmap converts the [product contract](./PRODUCT.md) into ordered delivery
phases. Work may overlap within a phase, but no phase exits until its stated
criteria are demonstrated. GitHub Project status reflects verified progress;
it does not replace these release gates.

Version 2.0 stabilizes the implemented foundation through hosted owner mode.
Incomplete local-loopback, publication, broader portability, governance, and
repository-profile work continues in the 2.1 iteration. Phase exit criteria
remain the parity gates for that work; moving an issue to 2.1 does not mark the
phase complete. See [ADR 0006](./ADR_0006_STAGED_V2_PARITY.md).

## Architecture boundaries

V2 must preserve the following boundaries throughout delivery:

### Domain and convergence

- One shared domain/protocol implementation defines item identity, validation,
  causal metadata, character-level note CRDT behavior, and deterministic
  materialization.
- Native clients and the hosted browser use the same pinned Loro CRDT protocol
  and pass cross-runtime golden tests.
- Notes merge at character granularity. Scalar values, tags, collection
  membership, lifecycle, and publication visibility use explicit causal rules;
  no Git state is consulted to choose application values.

### Local storage

- SQLite is the local transactional projection and search index, not a file to
  synchronize.
- A user mutation atomically updates domain state, its SQLite projection, and a
  durable outbound-update queue.
- Replaying accepted immutable updates can rebuild the projection on a new
  device. V1 sources are read-only inputs to an idempotent importer.

### Remote transport

- The GitHub adapter reads and appends immutable, uniquely addressed protocol
  updates in a private repository and verifies their payload hashes.
- Git is dumb transport and audit. The adapter may retry a branch-head race or
  an idempotent upload, but it must never ask Git to merge library data and must
  never surface ordinary concurrent editing as a manual Git conflict.
- The transport interface does not expose Git commits or branches to the domain
  layer, allowing another append-capable remote to be implemented later.

### User interfaces

- CLI, TUI, local web, and hosted web call the same application semantics.
- The local API binds only to loopback, uses a per-session credential, validates
  browser origin, and does not enable general cross-origin access.
- Hosted owner mode stores pending updates durably while keeping its
  repository-scoped PAT out of persistent browser storage and generated
  artifacts.

### Publication

- Synchronization and publication are separate pipelines and repositories.
- A pure projection step accepts materialized private state plus an explicit
  collection policy and emits only allowlisted public fields.
- Unresolved visibility is private. Any detected private-field leak fails the
  build rather than publishing a partial result.

## Phase 0: Product contract and safety

### Deliverables

- Adopt the V2 product contract, this roadmap, the repository `AGENTS.md`, and
  architecture decision records for consolidation and synchronization.
- Establish a green, reproducible Rust and JavaScript CI baseline with pinned
  toolchains, dependency locks, and third-party Actions.
- Disable Pocket-dependent deployment paths and prevent V1 static generation
  from serializing private notes or credentials.
- Adopt the [privacy threat model](./THREAT_MODEL.md),
  [synchronization protocol](./SYNC_PROTOCOL.md), repository topology, PAT
  permissions, browser token lifecycle, and publication boundary.
- Build representative, sanitized fixtures for supported V1 databases and
  legacy exports.

### Exit criteria

- Product, privacy, synchronization, and non-goal decisions are reviewable in
  the repository and linked from their tracking issues.
- CI runs formatting checks, linting, unit tests, secret scanning, and existing
  V1 regression tests without modifying source files.
- No supported publishing workflow depends on the retired Pocket service, and
  privacy regression tests cover all currently generated artifacts.
- The V1 fixture corpus contains notes, tags, favorites, archived items,
  duplicate URLs, malformed metadata, and legacy schema variants.

## Phase 1: Protocol and persistence foundations

### Deliverables

- Prove the pinned Loro implementation in Rust and WASM, including
  character-level note editing, serialized update compatibility,
  deterministic replay, and a pinned protocol version.
- Define the versioned V2 domain schema, item identifiers, causal operations,
  lifecycle/tombstone rules, set semantics, publication safety rule, and
  duplicate-URL behavior.
- Implement the V2 SQLite projection, full-text index, transactional outbox,
  idempotent replay, checkpoint format, and rebuild path.
- Implement read-only, idempotent import from V1 into a new platform data
  directory. Credentials from V1 are never queried or copied into V2 state.
- Consolidate V2 application code in ResearchPocket and mark `my-list` and
  `ResearchGarden` as legacy migration references.

### Exit criteria

- Native and WASM golden tests materialize identical state from the same update
  corpus.
- Randomized multi-client tests converge under reordered, duplicated, delayed,
  and partitioned delivery, including concurrent note, visibility, delete, and
  restore operations.
- Killing a process at each transaction boundary cannot create a projected
  mutation without its outbound update or lose an acknowledged update.
- A clean installation can import every V1 fixture twice with no source-file
  changes, no duplicate records, and documented field preservation.

## Phase 2: Complete local product

### Deliverables

- Ship V2 CLI commands for initialization, capture, CRUD, search,
  import/export, status, diagnostics, synchronization, and publication preview,
  with human, JSON, and NDJSON output contracts.
- Ship the TUI with keyboard-first parity for core capture, edit, search,
  collection, favorite, archive, delete, and restore workflows.
- Ship the local web application through a secured loopback API using the same
  application services and embedded frontend build.
- Make URL capture immediate offline and metadata enrichment asynchronous,
  observable, and retryable.

### Exit criteria

- A user can initialize, capture, edit, organize, search, delete, restore,
  import, and export entirely offline in each required local interface.
- Machine output is deterministic, schema-versioned, confined to stdout, and
  covered by compatibility fixtures; progress and diagnostics use stderr.
- Loopback security tests reject missing session credentials, invalid origins,
  non-loopback binding, and cross-origin browser control.
- Core workflows pass on Linux, macOS, and Windows, including keyboard and
  accessibility checks for the local web interface.

## Phase 3: Application-level synchronization

### Deliverables

- Implement the private GitHub repository adapter for immutable update upload,
  pull, idempotent retry, checkpoints, rate-limit handling, and full restore.
- Provide setup, explicit sync, status, diagnostics, and optional platform
  scheduling without requiring a continuously running ResearchPocket server.
- Keep Git branch races and transport retries inside the adapter; application
  convergence consumes update sets and remains independent of commit order.
- Add recovery guidance for corrupt remote objects, missing updates, credential
  revocation, and deliberate remote replacement.

### Exit criteria

- Two to five offline clients can edit independently, synchronize in arbitrary
  order, and converge without merge commits, conflict files, forced pushes, or
  user-selected winners.
- Duplicate upload, request timeout, rate limit, stale branch head, interrupted
  checkpoint, and out-of-order pull simulations are lossless and idempotent.
- A new device restores the materialized library and search index solely from
  the private repository and detects integrity failures rather than silently
  accepting corrupt updates.
- Git history shape and commit ordering have no effect on the final domain
  state for an identical set of valid updates.

## Phase 4: Hosted owner mode

### Deliverables

- Build the same protocol/domain core for WASM and use it in the GitHub Pages
  owner application.
- Implement fine-grained PAT onboarding with least-privilege validation and
  in-memory credential handling.
- Persist the browser's private materialized state and outbound updates in
  IndexedDB, while ensuring the PAT never enters IndexedDB, local storage,
  service-worker caches, URLs, logs, analytics, or generated output.
- Pull on startup, focus, before upload, after remote-head races, and at a
  documented visible-page interval; serialize uploads and verify ambiguous
  results by immutable update identity and hash.
- Enforce a self-hosted dependency policy and restrictive content security
  policy for owner mode.

### Exit criteria

- The hosted owner can load, search, add, edit, organize, delete, and restore
  any private item, including while temporarily offline.
- Reload, tab concurrency, expired/revoked PATs, transient API failures, and
  ambiguous upload responses preserve all queued user changes.
- Hosted browser, native clients, and multiple tabs pass the same partition and
  convergence scenarios without relying on Git merge behavior.
- Automated inspection proves credentials are absent from browser persistence,
  logs, network URLs, service workers, source maps, and public artifacts.

## Phase 5: Selective publication

### Deliverables

- Define collection publication policies and field allowlists, with notes
  excluded unless explicitly enabled.
- Generate accessible static collection views, JSON, RSS, and JSON Feed into a
  separate public Pages repository.
- Provide a local preview that uses exactly the production projection logic.
- Add a pinned private-repository workflow that publishes through a credential
  scoped only to the public repository.

### Exit criteria

- Selecting, previewing, publishing, unpublishing, and republishing a
  collection produce deterministic artifacts.
- Negative privacy tests scan HTML, scripts, embedded data, source maps, feeds,
  caches, and build logs and fail on any private item or non-allowlisted field.
- Concurrent or unresolved visibility changes remain private until a later
  explicit owner action resolves them.
- A public reader can browse and subscribe without JavaScript, GitHub access,
  or a ResearchPocket account.

## Phase 6: Release hardening

### Deliverables

- Run cross-platform upgrade, restore, offline, large-library, rate-limit,
  browser compatibility, accessibility, and privacy test matrices.
- Complete user and operator documentation for initialization, V1 import, PAT
  rotation, synchronization recovery, publication, backup, and remote reset.
- Publish versioned protocol and machine-interface compatibility guarantees.
- Add deprecation notices to legacy repositories after equivalent V2 workflows
  are available; archive them only after the documented parity gate passes.

### Exit criteria

- **Alpha:** protocol/persistence, V1 import, CLI, TUI, and local web gates pass.
- **Beta:** GitHub synchronization, hosted owner mode, and publication gates
  pass with recovery and privacy scenarios exercised against real test repos.
- **2.0 stable foundation:** implemented CLI, TUI, capture, enrichment, private
  synchronization, and hosted-owner paths pass their supported checks; release
  docs enumerate deferred surfaces and match the shipped interfaces.
- **V2 parity:** all supported platforms and required surfaces pass, a
  clean-room restore drill succeeds, no open P0/P1 correctness or privacy
  defects remain, and publication privacy gates pass.

## GitHub Project tracking conventions

- Track implementation work as repository issues attached to the applicable
  version milestone and iteration in the ResearchPocket V2 project; use draft
  items only for ideas that are not yet committed.
- Organize work under seven epics: product governance, V1 migration, data and
  CRDT, local experience, sync and hosted editing, publishing, and release.
- Every actionable issue contains Context, Deliverables, Acceptance criteria,
  Non-goals, and Dependencies. Acceptance criteria must name observable
  behavior or a test, not only an implementation activity.
- Set `Phase` to the roadmap phase, `Priority` to P0/P1/P2, and `Size` before an
  issue enters Ready. Record dependency relationships in GitHub rather than
  relying on issue-body checklists alone.
- Use continuous flow: Backlog, Ready, In progress, In review, and Done. An
  issue moves to In progress before repository changes, In review when its PR
  opens, and Done only after merge plus acceptance verification.
- Link every PR to its issue and call out protocol, privacy, migration, or
  machine-interface changes explicitly. Such changes require their contract
  tests and documentation in the same PR.
- A phase is complete only when all exit criteria above have evidence linked
  from its epic. Closing all issues is not sufficient if a release gate is
  unverified.

## Definition of done

A V2 issue is Done only when its accepted behavior is implemented, tests pass
in the required runtimes, failure and privacy cases are covered, public
interfaces are documented, migration or recovery implications are addressed,
and the linked PR is merged. Work that changes convergence rules additionally
requires native/WASM compatibility fixtures and randomized multi-client tests;
work that changes publication additionally requires negative leak tests.
