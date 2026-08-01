# ADR 0011: Bounded zen documents for authored prose, lists, and todos

- Status: accepted
- Date: 2026-08-02
- Issue: [#141](https://github.com/ResearchPocket/researchpocket.github.io/issues/141)
- Epic: [#140](https://github.com/ResearchPocket/researchpocket.github.io/issues/140)
- Depends on: [ADR 0010](./ADR_0010_BOUNDED_ITEM_SCOPED_SYNC.md)
- Amends: the V2 product contract ([PRODUCT.md](./PRODUCT.md) non-goals and
  explicit-revision list) and the repository `AGENTS.md` non-goals

## Context

The product contract lists standalone notes as a V2 non-goal and records
"URL-first" as a decision that may change only through an explicit revision.
Real demand exists for notes and todos that live in the library and converge
across devices (#139): a URL-backed save works today, but there is no home for
authored prose, running lists, or todos that reference saved links.

Making the item URL optional would answer that demand by weakening item
identity, capture validation, enrichment preconditions, and the machine output
contract at once. It would also turn every list surface into a mixed feed of
links and note fragments.

ADR 0010 gives the library aggregate-scoped CRDT state, a compact catalogue,
lazy content, checkpointed restore, and a fail-closed migration barrier. That
boundary makes a second aggregate kind affordable: a document can be authored,
synchronized, and loaded on demand without touching item semantics or
reintroducing whole-library work.

## Decision

### Items remain URL-first

`research add`, browser capture, enrichment, and item identity are unchanged.
An item without an absolute HTTP(S) URL remains invalid, and #139 remains
declined as filed. Zen documents are the deliberate, bounded exception for
authored prose, and this ADR is the explicit revision the product contract
requires.

The revised PRODUCT.md non-goal reads verbatim:

> Full webpage archival, PDFs, attachments, highlights, or a general-purpose
> wiki. Bounded zen documents (ADR 0011) are the only standalone authored
> prose: Markdown with item mentions, lists, and todos, never a note graph,
> attachment store, or archive.

The revised AGENTS.md non-goal reads verbatim:

> a general notes/wiki application; standalone authored prose is limited to the
> bounded zen documents of ADR 0011;

### Zen documents

A zen document is an authored Markdown document owned by the library:

- identity is UUIDv7, independent of any item;
- the title is a causal scalar register with the item title's semantics;
- tags use the existing add-wins observed-remove set semantics;
- delete and restore use the existing lifecycle-generation rules; and
- the body is one character-level CRDT text with the same Loro text semantics
  as item notes, so concurrent edits merge at character granularity.

The body is CommonMark plus GitHub-flavored task lists, bounded to 256 KiB of
UTF-8. Writes that would exceed the bound fail with an explicit error; raising
the bound requires a future ADR. Documents contain text only: no attachments,
no embedded binary content, and no captured-page bodies.

### Item mentions

A mention is a standard Markdown link whose destination uses the versioned URI
form `research:item/<uuid>`. The stored body never embeds item state. Rendering
resolves the UUID against the local projection at view time:

- an active item renders its current title and URL;
- a deleted item renders a non-navigating tombstone using its last materialized
  title; and
- an unknown UUID renders as an explicit unresolved reference.

Mentions are one-way references. There is no backlink index, no graph query
surface, and no automatic insertion of mentions. New `research:` reference
kinds require an ADR; the namespace is append-only.

### Todos and lists

Todos are GitHub-flavored task-list lines. Toggling a checkbox is a character
splice, so concurrent toggles and prose edits merge under the existing text
CRDT semantics without a dedicated register. Zen todos carry no scheduling,
reminder, or notification semantics.

### Aggregates and synchronization

Each zen document is its own aggregate in the ADR 0010 catalogue, declaring
aggregate kind `zen-document` version 1 and its UUID. Document updates travel
as the same immutable, uniquely addressed envelopes as item updates, and
checkpoints cover document aggregates exactly like item aggregates.

Zen documents exist only behind the `item-aggregates-v2` migration barrier;
they have no protocol-v1 representation. This ADR adds one requirement to the
#132 catalogue design: catalogue entries declare their aggregate kind, and a
client that encounters a recognized catalogue containing a required aggregate
kind it does not implement must fail closed rather than ignore or partially
apply it.

### On-demand loading

The workspace index materializes only document metadata: identity, title,
tags, lifecycle, timestamps, and body length. Document bodies load only when a
document is opened, are never embedded in list or bootstrap projections, and
are never fetched by opening the workspace surface itself.

Opening the workspace — including a future browser new-tab surface — performs
no full-history replay (restore rides ADR 0010 checkpoints), fetches no
captured documents, and defers synchronization to the existing explicit or
scheduled cadence. Startup work is proportional to the number of documents,
never to library size or body bytes.

### Search

Full-text search indexes document titles and body text beside item fields.
Search results are typed so every interface can distinguish items from
documents; a query that matches both returns both, clearly labeled.

### Publication

Zen documents never appear in publication artifacts. No allowlist path for zen
content exists, previewed or deployed, and adding one requires a future ADR.
The negative privacy scans that prove private fields are absent from published
HTML, embedded JSON, scripts, source maps, feeds, and caches extend to prove
the absence of all zen content.

### Target CLI and UI surface

```text
research zen list
research zen add [--title <TITLE>]
research zen show <DOC_ID>
research zen edit <DOC_ID>
research zen delete <DOC_ID>
research zen restore <DOC_ID>
```

Zen commands follow the existing global options and human/JSON/NDJSON output
contract, with document records versioned separately from item records. The
TUI and web application add workspace views calling the same application
services; the new-tab surface is a later epic deliverable, not part of this
contract. All of this is target surface for the v2.2 iteration, not shipped
behavior.

## Consequences

- The standalone-notes non-goal is revised deliberately and narrowly; items,
  capture, and enrichment contracts are untouched, and URL-less items remain
  invalid.
- A second aggregate kind forces the #132 catalogue to be kind-aware and
  fail-closed on unknown required kinds, which any future aggregate (for
  example collections) also needs.
- Zen ships only after the ADR 0010 migration barrier, sequencing the epic
  behind #132 and into v2.2.
- Representing structure as Markdown text keeps merge semantics proven and
  documents exportable as plain files, at the cost that malformed edits can
  break task-list syntax; rendering must stay forgiving of imperfect Markdown.
- Search, projection, machine output, and negative publication scans each grow
  a document dimension that must be specified when implementation issues are
  cut.

## Verification

- Native and WASM clients converge on one document under concurrent prose
  edits, todo toggles, reordering, duplication, and delay, preserving both
  edits at character granularity.
- Mention rendering reflects a concurrent item title edit, degrades a deleted
  item to a tombstone, and marks an unknown UUID unresolved without corrupting
  the document.
- Workspace index materialization contains no body bytes, and the 256 KiB
  body bound rejects oversized writes with an explicit error.
- A client that recognizes the catalogue but not a required aggregate kind
  stops before applying or uploading.
- Negative publication scans fail on any zen title, body fragment, or document
  identifier in any publication artifact.
