# ADR 0010: Bound restore work and scope durable content to items

- Status: accepted
- Date: 2026-07-28
- Issue: [#132](https://github.com/ResearchPocket/researchpocket.github.io/issues/132)
- Amends: [ADR 0003](./ADR_0003_OPERATION_PACKS.md),
  [ADR 0004](./ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md), and
  [ADR 0008](./ADR_0008_EXCERPT_AS_MERGED_TEXT.md)

## Context

The first production-sized private repository exposed two independent scaling
failures.

First, protocol v1 describes checkpoints but neither shipped transport creates
or consumes them. A pristine browser therefore downloads and replays the entire
immutable operation history. A 1,016-item library with 115 unique updates
expanded to 13.8 MB of envelope JSON, took about 34 seconds in the shared WASM
domain, and grew process RSS to roughly 1 GiB before IndexedDB persistence.

Second, the complete library is one Loro document. Every local or remote
mutation restores that document, returns a complete snapshot and private
projection, and rewrites the browser item store. A scalar update with a 448-byte
Loro payload returned about 13.7 MB of snapshot-plus-projection JSON. Retained
page Markdown represented about 91 percent of the projection.

Native callers also assigned a fresh Loro peer identity whenever they restored
the snapshot. One installation consequently added one causal-frontier peer per
edit instead of one peer per replica. The operation set remained convergent, but
frontier metadata and merge work grew with history length.

ADR 0004 deliberately put bounded Firecrawl Markdown in the existing excerpt
field to avoid an object boundary before real usage justified one. Real usage
now justifies that boundary. The product still does not need arbitrary
attachments or a general webpage archive.

## Decision

Delivery is staged so the existing private repository becomes usable before the
aggregate migration is required.

### Protocol-v1 bounded restore

Native and browser clients implement the checkpoint format already specified by
the synchronization protocol. A checkpoint contains one validated full Loro
snapshot and exact logical device-sequence coverage. It is immutable, optional,
and never replaces or prunes an operation.

Clients create a checkpoint after 100 newly covered logical batches or 2 MiB of
decoded update payload since the selected checkpoint. These lower operational
thresholds amend the original 1,000-batch/10-MiB requirement; clients may still
create equivalent checkpoints earlier. A manual or migration-triggered
checkpoint is always allowed.

A pristine replica selects the compatible checkpoint with the greatest exact
batch coverage, validates its path, payload hash, snapshot mode, frontier,
coverage, schema, codec, and library identity, then applies only logical updates
outside its coverage. Checkpoint selection cannot acknowledge a local outbox.
Every covered operation remains remotely immutable and recoverable.

Browser checkpoint validation and tail application run in a dedicated worker.
Verified state and observations are committed atomically. Reload or worker
failure leaves the previous snapshot usable and causes a safe retry.

### Stable replica identity and affected projections

One durable Loro peer identity belongs to one installation. Native clients
derive it deterministically from their persistent device UUID; browsers retain
their existing persisted peer ID. Restoring a local snapshot no longer creates
a new peer.

Domain mutation results contain the changed item projection rather than the
complete private projection. Remote application returns only projections whose
canonical values changed. SQLite and IndexedDB update those rows in the same
transaction as snapshot, receipt, and outbox state. Bootstrap is the only path
that replaces a complete materialized projection.

### Item aggregates and captured documents

The next synchronization generation treats an item as the consistency and CRDT
aggregate boundary:

- item-authored fields, note text, tags, lifecycle, and visibility converge in
  an item-scoped Loro document;
- collection definitions are separate aggregates when collections ship;
- a compact catalogue lists aggregate identities and ordering metadata without
  embedding item bodies; and
- an operation declares its aggregate kind and UUID, so apply and projection
  work are bounded by the changed aggregate.

Fetched full-page Markdown becomes an immutable private `CapturedDocument`
addressed by the lowercase SHA-256 of its exact normalized UTF-8 bytes. Item
state contains a causal reference with byte length, media type, provenance, and
content hash. Re-enrichment writes a new object and a small reference update.
The owner Reader fetches document bytes lazily. List/bootstrap projections never
embed them.

The authored excerpt remains an item field. Existing v1 excerpts remain
lossless. Migration may externalize an excerpt only when durable enrichment
provenance proves it is fetched content; ambiguous authored values remain
excerpt text. New Firecrawl enrichment writes `CapturedDocument`, not excerpt.

Captured documents use a private immutable path:

```text
sync/v2/content/sha256/<first-two-hex>/<sha256>.md
```

The decoded content hash must equal the path identity, content stays within the
existing 4 MiB UTF-8 bound, and publication excludes it unless a future
allowlisted policy explicitly says otherwise.

### Fail-closed migration

The aggregate protocol uses a new `sync/v2/` genesis and operation namespace.
Adding files only under that namespace is insufficient because protocol-v1
clients ignore it. Cutover therefore starts with a recognized protocol-v1
migration-barrier operation carrying the required
`item-aggregates-v2` feature. Older clients discover that operation during their
mandatory pull and stop before uploading.

A compatible client drains its local v1 outbox, applies the complete v1 set,
creates the canonical migration checkpoint, emits v2 catalogue/item state and
captured documents, and records the v1 checkpoint identity in v2 genesis.
Protocol-v1 history is retained without rewriting. Migration is idempotent by
library ID, checkpoint ID, aggregate ID, and content hash.

## Consequences

- Existing repositories gain a bounded restore path without changing merge
  semantics or immutable operation bytes.
- Future causal frontiers grow with replicas rather than native edit count.
- Ordinary saves and sync tail application persist only affected items.
- New full-page content no longer inflates catalogue/list materialization or
  scalar-edit results.
- Item-scoped documents add a versioned migration and more protocol objects, but
  make save, edit, checkpoint, and lazy-reader costs proportional to the item.
- Previously synchronized fetched Markdown cannot always be distinguished from
  authored excerpts. Ambiguous content stays inline until the owner explicitly
  moves it; the migration never guesses.
- Protocol-v1 clients fail closed after the migration barrier and must upgrade.

## Verification

- Restore a sanitized 1,000-item, 100-update fixture with 4 MiB of captured
  content from a checkpoint and apply an uncovered reordered tail.
- Reject mismatched checkpoint hashes, paths, frontiers, coverage, versions,
  codecs, libraries, and future required features.
- Prove that two native edits reuse one peer and do not widen the frontier.
- Prove local and remote scalar edits return and persist only affected item
  projections while native and WASM canonical state remains identical.
- Interrupt browser worker application before commit and verify the prior
  snapshot and outbox remain intact.
- Reject captured-document path/hash/size mismatches and prove list/bootstrap
  projections contain no document bytes.
- Verify that a protocol-v1 client stops on the migration barrier before
  applying or uploading and that repeated migration produces identical v2
  identities.
