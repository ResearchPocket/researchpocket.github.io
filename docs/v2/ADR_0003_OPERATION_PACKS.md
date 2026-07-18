# ADR 0003: Pack exact synchronization envelopes per upload flush

- Status: accepted
- Date: 2026-07-19
- Issue: [#68](https://github.com/ResearchPocket/researchpocket.github.io/issues/68)

## Context

ResearchPocket durably creates one immutable `UpdateEnvelope` for every local
mutation. Native and browser synchronization currently upload each queued
envelope with a separate GitHub Contents API request. GitHub consequently adds
one repository file and one commit for every edit, even when one explicit sync
flush contains many edits.

Git commits cannot become the unit of application state or conflict resolution.
Rebasing, squashing, force-pushing, replacing operation files, or asking the
owner to resolve a Git conflict would violate the synchronization contract. A
mutable rolling log would have the same race. Creating one Git commit containing
many operation files would reduce commit noise but would not reduce file growth.

An ordinary aggregate Loro envelope was also considered. It can be readable by
older clients, but exporting from the oldest pending causal frontier may repeat
an unbounded tail of already synchronized operations. It also replaces the
durable identities that the outbox, receipts, audit trail, and checkpoint
coverage currently use.

## Decision

### Local mutations remain independent

Every accepted mutation continues to atomically persist its exact immutable
envelope, projection, snapshot, sequence reservation, and outbox row. The Sync
preview continues to show those logical changes independently. Packing is a
transport step performed only after a complete pull has succeeded and no causal
dependency remains deferred.

If at least two envelopes are queued at the start of a flush, the client builds
one immutable operation pack from their exact UTF-8 JSON bytes. A single queued
envelope retains its existing direct operation file. New mutations arriving
after preparation wait for the next flush.

The pack path is:

```text
sync/v1/ops/packs/<device-uuid>/<sha256-of-exact-pack-bytes>.json
```

The body is strict UTF-8 JSON:

```json
{
  "format": "researchpocket-operation-pack",
  "protocol_version": 1,
  "pack_version": 1,
  "required_features": ["operation-packs-v1"],
  "extensions": {},
  "library_id": "019...",
  "device_id": "019...",
  "envelopes": [
    "base64-of-exact-update-envelope-json",
    "base64-of-exact-update-envelope-json"
  ]
}
```

The builder sorts members by device sequence. Every member must be a valid
protocol-v1 envelope for the pack library and device, identities must be unique,
and each Base64 value preserves the exact bytes already stored in the outbox.
The pack has no timestamp because its members already contain audit timestamps.
The lowercase SHA-256 in the path covers the exact serialized pack bytes.

A pack contains at most 1,000 envelopes and 20 MiB of exact serialized pack
bytes. An exceptional larger outbox is divided deterministically into bounded
packs; ordinary flushes therefore create one file and one Contents commit, while
the hard bound prevents an unbounded allocation or request.

### Receipts stay logical; observations stay physical

Pull validates the container path, byte hash, schema, required feature, library,
device, order, bounds, and every embedded envelope before committing any state.
The embedded envelopes then pass through the existing deterministic apply and
receipt path in one local writer transaction. Duplicate logical identities are
success only when their exact envelope bytes match, whether they arrived as a
direct file, in one pack, or in several duplicate packs.

The local `batches` and outbox tables continue to identify logical envelopes by
`(device_id, sequence)`. Applying a confirmed pack acknowledges each matching
member outbox row. `remote_observations` records the physical pack path and its
Git blob identity; it does not invent Git blob identities for embedded logical
paths. Attempt and retry state is applied to every member represented by an
outgoing pack.

An upload timeout or ambiguous server result retains every member row and the
same exact source bytes. The content-addressed pack can be rebuilt
deterministically. Discovery checks the pack path and exact bytes before retry.
Concurrent branch movement triggers another application-level pull and retry;
it never triggers a merge, rebase, force-push, or value choice based on Git.

### Compatibility and migration

Pack-aware clients accept both existing direct operation files and packs, so an
existing repository needs no rewrite, branch migration, or new genesis. Packs
live below the existing `sync/v1/ops/` prefix deliberately: a released client
that does not understand `operation-packs-v1` encounters a recognized but
unsupported operation and stops before uploading, instead of silently ignoring
new saves. After the first pack-enabled sync, every native or browser client for
that library must be upgraded before it can sync again.

This is a transport feature inside protocol version 1. It does not alter the
domain schema, Loro merge rules, item projection, or direct-envelope format.
Logical receipts and checkpoint coverage count embedded envelopes rather than
container files. Discovery/download counters continue to describe physical
remote protocol objects; apply, acknowledgement, upload, and pending counters
describe logical envelopes.

### Recovery

A fresh pack-aware client can rebuild the library from immutable genesis plus
all direct operations and pack members, optionally accelerated by a checkpoint.
If a pack path/hash, member byte hash, identity, version, feature, or payload is
invalid, the complete pack transaction rolls back and local state/outbox data is
preserved. Existing repository history is never compacted or deleted. Secure
erasure still requires the separate repository-replacement procedure.

## Alternatives considered

### Squash or rewrite Git commits

Rejected. Commit topology is transport audit metadata, not application state.
History rewriting does not safely reduce live protocol objects and introduces
the exact source-control conflict workflow ResearchPocket excludes.

### Create one Git commit with many operation files

Rejected for this goal. Git's tree/commit APIs could reduce commit count, but
the repository would still gain one file for every edit and the branch-head API
surface would become larger.

### Export one aggregate Loro update

Rejected. It can duplicate an unbounded causal tail and obscures the relationship
between durable local envelope identities, remote receipts, and checkpoint
coverage. Exact-envelope packs achieve the repository reduction without
changing the semantic operation set.

### Append to one mutable log file

Rejected. Competing clients would replace the same path, making branch order or
manual Git conflict handling part of convergence.

## Consequences

- A normal multi-edit sync adds one immutable repository file and normally one
  GitHub commit while preserving every logical update and Sync preview row.
- Retries and duplicate delivery remain byte-exact and idempotent.
- Native and browser clients need one shared pack codec and transactional pack
  application path.
- Pack-enabled repositories require pack-aware clients; older preview clients
  fail closed until upgraded.
- Existing operation files and commits remain valid and are not rewritten.
