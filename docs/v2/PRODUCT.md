# ResearchPocket V2 Product Contract

Status: accepted direction for V2 planning and implementation

## Vision

ResearchPocket is a local-first, URL-first personal library for developers. It
helps one person intentionally save, curate, retrieve, and selectively share
knowledge without turning that knowledge into an AI profile or depending on a
continuously running application server.

The local library remains useful offline. A private GitHub repository provides
remote durability and transport, and a GitHub Pages application provides both
public read-only projections and an authenticated owner experience. Git is not
the database and Git merge behavior is never used to resolve application data
conflicts.

## Product principles

1. **Human first.** User-authored titles, notes, tags, collections, and status
   are canonical. Automation may assist later, but it must not silently replace
   a person's organization.
2. **Local first.** Capture, editing, search, import, and export work without a
   network connection or account.
3. **Owned and portable.** The live library has documented, versioned formats
   and can be reconstructed without a hosted ResearchPocket service.
4. **Private by default.** The complete library is protected by the private
   repository's access controls. Only explicit, allowlisted projections become
   public.
5. **Convergence belongs to the application.** ResearchPocket exchanges
   immutable updates and resolves concurrent work through CRDT and causal
   semantics. GitHub stores and transports those updates; commits, branches,
   and merge conflicts do not decide the winning user data.
6. **Integration is a feature.** The CLI, machine-readable output, loopback API,
   imports, exports, and feeds are stable product surfaces rather than
   afterthoughts.

## Audience and personas

V2 is intentionally developer-only. Setup may assume familiarity with a CLI,
GitHub repositories, and fine-grained personal access tokens. Removing that
requirement is a possible later product track, not a V2 release requirement.

### Developer-owner

The primary user maintains one personal library across computers and browsers.
They want fast offline capture, transparent storage, reliable recovery, and
control over exactly what is published. They use the CLI, TUI, local web UI,
and hosted owner UI interchangeably.

### Tool integrator

A developer connects editors, scripts, browser capture tools, launchers, or
other personal workflows to ResearchPocket. They need deterministic commands,
versioned schemas, machine-readable output, and a loopback API.

### Public reader

A person follows a deliberately published collection without access to the
owner's private library. They need a fast, accessible static site and standard
feeds; they do not need a ResearchPocket or GitHub account.

## V2 use cases

### Capture and curation

- Save a URL immediately while offline; metadata enrichment may be retried and
  must never block or discard the save.
- Fill only missing title, excerpt, and language fields through an explicit
  local direct fetch or user-configured Firecrawl service. Firecrawl enrichment
  retains its bounded cleaned Markdown in the existing excerpt register for
  offline reading; direct enrichment remains metadata-only. Human-authored
  values remain canonical across in-flight and concurrent edits, local job
  leases avoid duplicate provider calls, and using Firecrawl is a visible
  third-party disclosure.
- Capture bounded title, description, and language metadata from the current
  browser DOM plus optional non-sensitive prompted tags through the installed
  local protocol handler without requiring a browser extension or always-on
  backend.
- Edit titles, notes, tags, collection membership, favorite state, archive
  state, and lifecycle state through the CLI, TUI, or local web UI.
- Undo the latest browser add, edit, favorite, tag, delete, or restore action as
  a convergence-safe compensating mutation; deleted items remain recoverable
  from the archive after the immediate undo affordance is dismissed.
- Search locally across saved metadata and user-authored notes.
- Keep concurrently saved copies of the same URL visible for review rather
  than silently deleting one person's intent.

### Remote use and synchronization

- Restore a complete V2 library on a new device from its private GitHub data
  repository.
- Open the GitHub Pages application, authenticate owner mode with a
  repository-scoped fine-grained PAT, load the complete private library, and
  create or edit saves.
- Continue editing in the hosted UI while temporarily offline and upload the
  queued updates after connectivity returns.
- Make concurrent changes in local clients, hosted browser sessions, or tabs
  and converge without manual Git operations or lost note text.
- Merge concurrent note edits at character granularity. Resolve other fields
  with documented causal application semantics, including safe handling for
  deletion, restoration, tags, collection membership, and visibility.

### Publishing and integration

- Select collections for publication while the rest of the library remains
  private.
- Preview the exact publication projection before it is deployed.
- Publish allowlisted fields as a static site, JSON, RSS, and JSON Feed from a
  repository separate from the private data repository.
- Import an existing V1 SQLite library into a new V2 library without modifying
  the source database.
- Import Pocket exports, browser bookmarks, and documented JSON/CSV formats;
  export canonical data in portable formats.
- Operate and integrate through stable human, JSON, and NDJSON CLI output and a
  versioned loopback API.

## Required V2 surfaces

- A Rust CLI for capture, editing, search, import/export, synchronization,
  diagnostics, and publication setup.
- A keyboard-oriented TUI with parity for core library management.
- A loopback-only local web UI backed by the same application services as the
  CLI and TUI.
- A static GitHub Pages application with anonymous public collection views and
  full private owner mode.
- A private GitHub data repository containing versioned immutable updates and
  rebuild material, protected by GitHub repository access control.
- A protected public source/Pages repository containing only the application
  shell, plus separate public publication repositories containing sanitized
  projections.

The owner PAT must be fine-grained, limited to the private data repository, and
granted only the permissions required to read and append synchronization data.
It must not be embedded in generated files, URLs, logs, analytics, persistent
browser storage, or service-worker caches. Owner mode must remain usable when
the token expires or is revoked: local pending changes stay queued until the
owner supplies valid credentials. The complete trust boundary and token
lifecycle are defined in the [privacy threat model](./THREAT_MODEL.md); the
immutable repository and convergence contract is defined in the
[synchronization protocol](./SYNC_PROTOCOL.md).

## Success criteria

V2 is successful when all of the following are true:

- A developer can initialize a library, save and find a URL offline, and use
  core editing workflows from the CLI, TUI, and local web UI.
- A V1 database can be imported repeatedly into a new V2 library without
  altering the original or duplicating imported records.
- Two to five clients can edit during a network partition, reconnect in any
  order, receive duplicate or reordered updates, and materialize identical
  library state without a Git merge or user-selected winner.
- Simultaneous edits to different portions of a note preserve both edits at
  character granularity in native Rust and browser/WASM clients.
- Hosted owner changes survive reloads, offline periods, transient GitHub API
  failures, expired credentials, and synchronization retries.
- A new device can rebuild the complete current library and search index from
  remote V2 data.
- Publication tests prove that private items, non-allowlisted fields, private
  notes, credentials, tombstones, and synchronization history never appear in
  public HTML, JavaScript, source maps, JSON, or feeds.
- The documented machine interfaces remain deterministic and versioned, and
  supported releases pass Linux, macOS, Windows, native/WASM convergence, and
  browser end-to-end test suites.

## V2 non-goals

- Non-technical onboarding, hosted ResearchPocket accounts, or hiding the
  GitHub repository/PAT setup from the owner.
- Using Git commits, branch merges, file locking, or last-push-wins as the
  application conflict-resolution model.
- Multi-user or real-time collaborative libraries. V2 supports one human owner
  using many devices, browsers, and tabs.
- AI memory, personal profiling, RAG, autonomous organization, or canonical
  machine-generated tags and summaries.
- Standalone notes, full webpage archival, PDFs, attachments, highlights, or a
  general-purpose wiki.
- Autonomous crawling, AI-generated memory, automatic provider fallback, or
  silently sending saved URLs to a third-party extraction service.
- Native mobile applications.
- End-to-end encryption of remote state or encrypted public sharing. V2 trusts
  GitHub's private-repository access control; encryption can be added behind
  the storage boundary later.
- S3, WebDAV, or other remote providers. V2 defines a transport boundary but
  ships GitHub as its only remote.
- Secure deletion from existing Git history. V2 deletion affects materialized
  state; erasing historical remote data requires a documented repository
  replacement or history-rewrite procedure.

## Product decisions that require an explicit V2 revision

The following are contractual, not incidental implementation details:

- V2 remains URL-first and developer-only.
- The V1 database is imported into a new V2 library and is never migrated in
  place.
- The complete private library is editable from GitHub Pages owner mode.
- Notes use character-level CRDT semantics; other domain fields use explicit
  causal application rules.
- Git is a replaceable storage/transport and audit mechanism, never the merge
  engine for user data.
- Publication is an explicit, field-allowlisted projection into a separate
  repository.
- Core V2 development is consolidated in the ResearchPocket repository.

Changing any of these decisions requires an architecture decision record and
an update to this contract before implementation diverges.
