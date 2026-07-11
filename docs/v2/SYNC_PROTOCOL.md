# ResearchPocket synchronization protocol v1

Status: protocol decision for issue #33

Protocol version: 1  
Domain schema version: 2  
Loro codec: 1.13.6  
GitHub REST API version verified: 2026-03-10

## Decision

ResearchPocket synchronizes immutable Loro update batches through a private
GitHub repository. GitHub provides authenticated blob storage, transport,
triggering, and an audit trail. Git commits, branches, timestamps, merges, and
repository history never choose application values.

SQLite, IndexedDB, search indexes, rendered JSON, and generated pages are local
or publication projections. They are never synchronization objects. A client
converges by validating and applying the same set of immutable protocol updates,
regardless of their delivery or commit order.

This protocol inherits the token, repository, browser-storage, CSP, and
publication rules in the [privacy threat model](./THREAT_MODEL.md).

## Protocol invariants

1. One private data repository contains one ResearchPocket library.
2. Every library, device, item, update batch, and checkpoint has an
   application-defined identity independent of Git object IDs.
3. An operation path is written once. Existing identical bytes are an
   idempotent success; different bytes at the same path are an integrity error.
4. A local mutation is durable with its projection and outbox entry before any
   upload.
5. Pulling and applying a valid update is deterministic and idempotent under
   duplication, delay, reordering, retries, and partitions.
6. A transport error never discards or rewrites an outbox item.
7. No client asks Git to merge application state and no user resolves a Git
   conflict to reconcile saves.
8. Checkpoints accelerate bootstrap but never replace or prune operation
   history.
9. Unsupported protocol, schema, codec, or required-feature data stops sync
   before application and preserves local state for an upgraded client.
10. Synchronization and public publication use separate repositories and
    credentials.

## Identities

| Identity | Format and rule |
| --- | --- |
| Library | Canonical lowercase UUIDv7, generated once at `research init`. |
| Device | Canonical lowercase UUIDv7, unique to one native installation or browser device. |
| Item | Canonical lowercase UUIDv7. Equal URLs do not imply equal items. |
| Device sequence | Decimal integer `1..=u64::MAX`, encoded as exactly 20 digits with leading zeroes. Gaps are allowed; reuse is forbidden. |
| Batch | Tuple `(library_id, device_id, sequence)`. The repository path contains device and sequence. |
| Loro peer | Unsigned 64-bit Loro identifier. It is causal metadata, not a device or user identity. |
| Checkpoint | Lowercase SHA-256 of the decoded full Loro snapshot payload. |
| Collection | Canonical lowercase UUIDv7 when the collections feature is introduced. Names are mutable labels, not identity. |

A device reserves/advances its sequence in the same local transaction that
stores the immutable batch. A crash may leave a sequence gap but cannot assign
the same sequence to different bytes. Browser tabs either serialize one device
sequence with Web Locks or use distinct device UUIDs.

## Repository layout

```text
sync/
  v1/
    library.json
    ops/
      <device-uuid>/
        <20-digit-sequence>.json
    checkpoints/
      <snapshot-sha256>.json
```

`sync/v1/library.json` is immutable genesis metadata created during setup:

```json
{
  "format": "researchpocket-sync",
  "protocol_version": 1,
  "domain_schema_version": 2,
  "loro_codec": "1.13.6",
  "required_features": [],
  "library_id": "019...",
  "created_at": "2026-07-11T00:00:00Z"
}
```

The timestamp is audit metadata. The file has no mutable branch head,
checkpoint pointer, device list, or current state. If genesis already exists,
setup accepts only the same library and compatible versions; otherwise it stops
without replacing the file.

Files outside `sync/v1/` are ignored. Within the protocol tree, a recognized
path with an invalid identity, non-blob Git entry, duplicate semantic identity,
or incompatible document is an integrity error. Symlinks and submodules are not
protocol objects.

## Update envelope

An operation file is UTF-8 JSON containing one `UpdateEnvelope`:

```json
{
  "protocol_version": 1,
  "domain_schema_version": 2,
  "loro_codec": "1.13.6",
  "required_features": [],
  "extensions": {},
  "library_id": "019...",
  "device_id": "019...",
  "sequence": "00000000000000000001",
  "causal_frontier": { "101": 12 },
  "created_at": "2026-07-11T00:00:00.000Z",
  "payload": "base64-encoded-loro-update",
  "payload_sha256": "64-lowercase-hex-characters"
}
```

Validation is performed in this order:

1. file path matches `sync/v1/ops/<device>/<sequence>.json`;
2. JSON contains only the specified fields;
3. protocol, domain schema, Loro codec, and required features are supported;
4. library and device are canonical UUIDv7 values, and path device equals body
   device;
5. sequence is exactly 20 digits, is nonzero, and equals the path sequence;
6. `created_at` is valid RFC 3339 UTC but is never merge input;
7. frontier keys are decimal unsigned Loro peer IDs and counters are valid
   nonnegative codec counters;
8. payload is padded standard Base64 and decoded bytes match the lowercase
   SHA-256; and
9. Loro recognizes the decoded bytes as an update before import.

`causal_frontier` is the producer's pre-mutation VersionVector. It aids audit,
diagnostics, checkpoint validation, and missing-dependency detection. It does not
change Loro's merge rules.

JSON whitespace and object-key order are not domain semantics. A producer stores
the exact bytes it attempted to upload and reuses those bytes for every retry.
If another blob already occupies its batch path, byte equality is required for
idempotent success; semantically similar but byte-different JSON is an integrity
failure. Only namespaced optional data belongs in `extensions`. A feature that
changes validation or materialization must appear in sorted
`required_features` and requires explicit client support.

Envelopes produced before negotiation fields were added omit
`domain_schema_version`, `loro_codec`, `required_features`, and `extensions`.
Protocol-v1 readers interpret those omissions as schema 2, codec 1.13.6, and
empty feature/extension sets. No other missing required field receives a
default.

## Domain convergence rules

The payload is an opaque Loro update. Git and the transport do not inspect or
choose field values. Domain schema 2 applies these rules:

- **Identity and duplicate URLs:** items use UUIDv7 identity. Multiple items may
  have the same URL and remain visible until the owner explicitly curates them.
- **Notes:** Loro character-level text. Concurrent edits retain independently
  inserted characters rather than selecting one whole note.
- **Scalars:** URL, nullable title, nullable excerpt, favorite, nullable
  language, and original saved time are causal registers. Every immutable
  revision records observed parent heads. The visible winner is deterministic,
  while all concurrent revisions remain recoverable.
- **Tags:** exact-text add-wins observed-remove sets. Remove records all observed
  add dots; an unseen concurrent add remains visible.
- **Lifecycle:** active/deleted revisions carry explicit generations and causal
  parents. Restore is valid only after observing deleted heads. Ordinary edits
  never resurrect an item.
- **Collections:** collection membership uses the same add-wins observed-remove
  rule as tags. Collection metadata uses causal scalars. Until the negotiated
  collections feature lands, absence means no membership.
- **Visibility:** private/public is a privacy-biased causal register. If any
  concurrent visible head is private, materialized visibility is private. Public
  becomes visible only through a later explicit revision that observes and
  resolves every competing head. Until the negotiated visibility feature lands,
  absence means private.

Collections and visibility require a future domain-schema/feature negotiation;
protocol v1 reserves their convergence behavior but does not silently reinterpret
schema-2 payloads. Publishers consume only the validated materialized visibility
and collection policy and fail closed on missing or unsupported state.

## Local transaction and receipts

For a local mutation, one SQLite writer transaction:

1. acquires the writer lock before reading canonical state;
2. verifies and loads the full Loro snapshot;
3. performs the domain mutation;
4. materializes the affected local projection/search rows;
5. stores the new full snapshot and checksum;
6. stores the exact immutable envelope and batch identity;
7. inserts the durable outbox row; and
8. advances the device sequence.

Commit exposes all effects; rollback exposes none. SQLite itself is never
uploaded.

For a remote batch, one writer transaction verifies the envelope, checks the
local applied-batch receipt `(device_id, sequence, payload_sha256)`, imports the
Loro update, rebuilds affected projections, stores the canonical snapshot, and
records the receipt. A duplicate identity/hash is success without a new local
outbox item. A duplicate identity with another hash is an integrity error.

## Discovery and download

Clients use the Git Trees API recursively to discover protocol blobs and the Git
Blobs API to download their exact bytes. The Contents directory endpoint is not
used for enumeration because one directory response is limited to 1,000 entries.
If a recursive tree response is marked truncated, the client walks subtrees until
every protocol path is accounted for.

Requests stay on `https://api.github.com`, use Bearer authentication, and pin:

```text
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2026-03-10
```

The browser uses `cache: "no-store"`; service workers bypass all API traffic.
Native clients do not place authorization headers, response bodies, private
paths, or item fields in logs.

Clients sort discovered operation identities by `(device_id, sequence)` for
repeatable diagnostics, but correctness is independent of that processing
order. An update may arrive before its causal predecessor; Loro retains causal
information and convergence is checked after the complete discovered set is
applied.

## Upload, idempotency, and branch races

Clients upload one outbox file at a time through
`PUT /repos/{owner}/{repo}/contents/{path}` with Contents write permission. The
body contains the exact operation-file bytes encoded once more as Base64 for the
API. The commit message may identify the protocol path for audit, but no client
reads it as state.

Before upload, the client refreshes discovery. For each batch:

- absent path: attempt create without a `sha` replacement parameter;
- existing path with identical bytes: mark uploaded (idempotent success);
- existing path with different bytes: stop with an integrity error;
- `409`, `422`, timeout, or ambiguous connection loss: refresh the tree/blob,
  perform the same equality check, and retry the unchanged outbox bytes with
  bounded jitter;
- `401`: require a new credential and preserve the outbox;
- `403`/`429`: honor rate-limit/reset/retry headers and preserve the outbox;
- `5xx` or offline: exponential backoff with jitter and preserve the outbox.

Contents writes are serialized because GitHub documents conflicts for
concurrent content mutations. A branch-head race is transport contention, not an
application conflict: pull unseen immutable batches, retry the original unique
path, and never merge, rebase, force-push, rewrite, or choose a last writer.

After pushing all currently queued files, the client pulls once more. This
closes the race in which another device uploaded after the first pull.

## Synchronization cycle

An explicit or scheduled sync performs:

```text
validate configuration and immutable library genesis
discover remote operation and checkpoint blobs
select/validate an optional compatible checkpoint
download and atomically apply every unseen valid operation
upload queued local operations serially and idempotently
discover/download/apply once more
report local pending count, remote observations, and any retry state
```

Native clients run this cycle for `research sync`, safe application start/exit
hooks, and optional OS scheduling. Hosted owner mode runs on startup, window
focus, before upload, after an upload race, and every 60 seconds while visible.
Only one browser upload loop runs at a time; other tabs observe IndexedDB/outbox
changes and may pull.

## Checkpoints

A checkpoint is an immutable JSON envelope at
`sync/v1/checkpoints/<snapshot-sha256>.json` containing:

```json
{
  "protocol_version": 1,
  "domain_schema_version": 2,
  "loro_codec": "1.13.6",
  "required_features": [],
  "library_id": "019...",
  "checkpoint_id": "snapshot-sha256",
  "created_at": "2026-07-11T00:00:00.000Z",
  "frontier": { "101": 42 },
  "coverage": {
    "device-uuid": [
      { "start": "00000000000000000001", "end": "00000000000000000042" }
    ]
  },
  "batch_count": 42,
  "payload": "base64-full-loro-snapshot",
  "payload_sha256": "snapshot-sha256"
}
```

Coverage is an exact set of inclusive sequence intervals; it does not assume
sequences are contiguous. The checkpoint ID and path equal the decoded snapshot
SHA-256. A client validates versions, library, path, coverage syntax, snapshot
hash, Loro snapshot mode, and snapshot frontier before use.

Create a checkpoint after either 1,000 newly applied batches or 10 MiB of
decoded update tail since the selected checkpoint. Checkpoint creation is an
optimization and may be repeated by several devices. Clients select a compatible
valid checkpoint with the greatest `batch_count`, breaking ties by lowercase
checkpoint ID, then apply every discovered operation outside its exact coverage.
Selection order cannot change final state.

Every operation remains in the repository. A client can ignore checkpoints and
rebuild from the full operation set, and diagnostics provide that fallback when
checkpoint validation fails. Protocol v1 never deletes or rewrites operations or
checkpoints.

## Version negotiation

A client advertises an internal supported tuple:

```text
protocol versions: {1}
domain schema versions: {2}
Loro codecs: {1.13.6}
required features: {}
```

Genesis, checkpoint, and every operation must fit that tuple. Protocol v1 does
not perform best-effort partial application. On an unsupported value, the client:

1. stops before applying further remote data or uploading local outbox data;
2. reports `upgrade_required` with only version/feature identifiers;
3. preserves canonical local state and every outbox item; and
4. resumes after a compatible client upgrade.

Unknown top-level envelope fields are rejected. Optional forward metadata must
be namespaced inside `extensions` and cannot affect validation, convergence,
privacy, or publication. Any new semantic requirement uses
`required_features`; incompatible structural or codec changes increment the
domain schema or protocol version.

The shared native/WASM convergence scenario is the executable protocol-v1
fixture. It uses fixed peers, identities, timestamps, duplicated/reordered
envelopes, character-level note edits, causal scalar revisions, exact add-wins
tags, delete/restore generations, snapshot restore, and a byte-stable canonical
projection. The same scenario rejects future protocol/schema/codec values and
unknown required features. CI runs it natively and in a headless browser.

## Browser, publisher, and CLI consumption

- **CLI/native:** SQLite holds canonical snapshot, projection, applied receipts,
  immutable batches, and outbox. Credentials live outside SQLite.
- **Browser owner mode:** IndexedDB holds the equivalent private state and
  outbox. The PAT follows the threat-model lifecycle and never enters IndexedDB
  or service-worker/cache state.
- **Publisher:** reads only validated compatible updates/checkpoints, derives the
  private materialized state, then runs the separate fail-closed publication
  projection. It never publishes protocol files or treats the public repository
  as editable owner state.
- **Anonymous reader:** never reads the private data repository or protocol.

## Recovery and integrity failures

- Missing local SQLite/IndexedDB state is recoverable from genesis plus all valid
  operations, optionally accelerated by a checkpoint.
- Missing remote operation paths, path/body mismatches, hash mismatch, sequence
  collision, incompatible versions, invalid Loro bytes, or a checkpoint claiming
  invalid coverage stop sync and retain local/outbox data.
- A user may explicitly replace a corrupt remote with a newly initialized private
  repository after exporting/verifying current local state. Clients do not
  silently heal remote history through force-push.
- Tombstones do not securely erase historical updates. Follow the threat model's
  repository-replacement/history-rewrite procedure when erasure is required.

## Non-goals

- Git merge semantics, shared mutable state files, last-push-wins, or manual
  source-control conflict resolution;
- a continuously running ResearchPocket backend;
- multi-user collaboration or authorization within a library;
- end-to-end encryption of the private repository;
- pruning or garbage collection in protocol v1; and
- publication or anonymous access through the private synchronization protocol.

## Normative external API references

- [GitHub repository Contents API](https://docs.github.com/en/rest/repos/contents)
- [GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)
- [GitHub fine-grained token permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)

Changes to paths, identities, merge rules, privacy defaults, checkpoint coverage,
or version negotiation require a new protocol decision and updated native/WASM
fixtures before implementation diverges.
