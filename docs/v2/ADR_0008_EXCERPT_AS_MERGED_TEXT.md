# ADR 0008: Represent excerpt as merged text

- Status: accepted
- Date: 2026-07-25
- Issue: [#116](https://github.com/ResearchPocket/researchpocket.github.io/issues/116)

## Context

Excerpt was a causal scalar register. Every edit inserted an immutable
`{parents, value}` record holding the whole excerpt, so a one-character change
to a 3,599-byte excerpt cost 3,864 bytes of Loro update, 5,564 bytes of envelope
JSON, and roughly 9,890 bytes uploaded once packed and base64-encoded. Protocol
v1 never prunes operations, so that cost is permanent.

Register semantics are right for `title`, `language`, and `favorite`, where a
whole value genuinely competes with another whole value. They are a poor fit for
a paragraph of prose, where there is no way to say "one character changed".

The cheap representation already exists in the same document: `note` is a
`LoroText` container, and a one-character note edit costs 138 bytes.

## Decision

Excerpt becomes a `LoroText` container alongside `note`, and the domain schema
version becomes 3.

Concurrent excerpt edits now merge character by character instead of surfacing
competing revisions. This is the substantive trade: two devices that edit one
excerpt offline produce a single interleaved excerpt rather than a visible
conflict with recoverable heads. Excerpt is descriptive prose about a saved
page, usually authored once and rarely contested, so a merge that keeps both
contributions is a better default than a register whose loser is only reachable
through history. Fields where competing whole values are meaningful keep
register semantics.

Text carries no notion of absence, so a blank excerpt and a missing excerpt are
the same state. Two consequences follow: the projection reports excerpt as a
plain string, and enrichment treats an empty excerpt as fillable, where a
scalar could previously record "the author deliberately set this to empty".

### Migration

Existing libraries migrate lazily and without rewriting history.

- **Reading** falls back to the scalar register whenever an item has no excerpt
  text container. The fallback derives only from operations already in history,
  so replicas that never edit an item agree without either of them writing
  anything.
- **The first edit** of a pre-schema-3 item creates the container and writes the
  new excerpt once in full. That single write costs what an edit used to cost.
  Every later edit is a minimal splice.
- **Nothing is rewritten.** `library_id`, device sequences, and stored operation
  bytes are untouched, and the scalar revisions stay in history.

Two devices that migrate the same item concurrently both write a full value, and
those values merge into one excerpt. This is the same merge rule that applies to
every later edit, so it is consistent rather than special-cased, but it is the
one case where migration is visible to the owner.

### Version negotiation

Genesis and envelope validation previously required exact equality with
`DOMAIN_SCHEMA_VERSION`. Bumping the constant under that rule would have made a
new client reject every existing repository. Validation now accepts any schema at
or below its own and rejects only future schemas. The break is one-directional:
a schema-2 client rejects schema-3 operations, which is the intended fail-closed
behavior.

### Enrichment

Enrichment guarded excerpt writes with a compare-and-swap on the scalar revision
ID, and recognized an excerpt it had written by a `!researchpocket-enrichment`
revision prefix. Text has neither identity nor authorship, so both mechanisms are
replaced:

- The CAS token is the excerpt text observed when the job was queued, stored in
  `item_enrichment_jobs.expected_excerpt_text`. This mirrors how `expected_note`
  already guards note edits.
- Authorship is tracked out of band in `applied_excerpt_text`, holding whatever
  excerpt enrichment last wrote. A requeue may refresh an excerpt that still
  reads exactly as enrichment left it, and never touches one a human has since
  changed.

## Consequences

A one-character excerpt edit costs 141 bytes of Loro update and about 1,069
bytes uploaded, down from roughly 9,890 — a 2.7x amplification becomes 0.3x.
Twenty consecutive edits of a 3,599-byte excerpt grow the local snapshot by 6
bytes each.

Owners lose the ability to recover a competing concurrent excerpt as a distinct
revision, and lose "deliberately empty" as a state distinguishable from unset.
Clients older than schema 3 stop accepting operations from clients on schema 3.
