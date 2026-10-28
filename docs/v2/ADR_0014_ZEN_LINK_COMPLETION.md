# ADR 0014: Zen document links, completion, and derived backlinks

- Status: accepted
- Date: 2026-10-28
- Issue: [#198](https://github.com/ResearchPocket/researchpocket.github.io/issues/198)
- Amends: [ADR 0011](./ADR_0011_ZEN_DOCUMENTS.md) reference namespace and
  [ADR 0012](./ADR_0012_DERIVED_LIBRARY_GRAPH.md) on-demand relationship readers

## Context

The owner needs to insert links without copying UUIDs, follow them between Zen
and saved items, and see which documents link to the current target, including
on a phone. Existing Markdown bodies provide the canonical authored text.

## Decision

Append `research:zen/<uuid>` to the existing `research:item/<uuid>` reference
namespace. Both are ordinary Markdown destinations in character-level CRDT text.
The UUID is canonical; the label is an escaped, portable snapshot of the title.
The hosted reader resolves current titles locally. Existing clients retain the
text without understanding the new reference kind; their readers may omit the
unknown scheme. No envelope, aggregate kind, schema, or migration changes.

Zen editing offers local metadata completion on `[[`, replacing the trigger and
query with a Markdown link only after an explicit selection. An Insert link action
opens the same picker with a search field, using the textarea's selected range.
There is no unresolved-title binding or automatic document creation. Deleted
targets and the current document are omitted from suggestions. Missing/deleted
document references remain visible as unavailable, preserving their authored
label and destination. Following a saved-item reference opens its owner Reader.

A target's Linked from view scans live Zen document bodies on demand through
the existing worker-backed application reads, one bounded document at a time.
It derives reverse references from actual Markdown links, including reference
links, excluding images, code examples, and bare URI text. Duplicate mentions
count once; self links are omitted. A failed scan shows an explicit failure
rather than presenting a partial list as complete. The result lives only in
the mounted view and is refreshed when document metadata changes; nothing is
persisted, synchronized, exported as structure, or published. Closing a target
discards its result. Library startup and the Zen index still read no bodies.
This expands ADR 0012's allowed readers to the target inspector; graph projection
semantics and its existing mention extraction stay unchanged.

## Consequences and recovery

Finding backlinks costs work proportional to live Zen body bytes when opening
a target or refreshing its document list. Reads run sequentially through the
worker and show a loading state; no whole-library body array is retained.
Completion uses only already-loaded metadata and works offline. Mobile selection
uses large touch targets and positions the picker above the visual viewport's
software keyboard. IME composition is never accepted as a completion keystroke.

The existing 256 KiB body bound, atomic persistence/outbox, and CRDT semantics
apply to inserted text unchanged. Removing this UI leaves readable Markdown in
the library. No rollback migration is required. Zen content and relationship
metadata remain excluded from all publication artifacts. This does not introduce
a general wiki, new graph mutation, item-note editor, or native mobile app.

## Verification

The focused Markdown contract checks exact destinations, reference syntax,
deduplication, code/image exclusion, and literal escaping of inserted titles.
Browser verification covers keyboard selection and dismissal, mobile viewport
picker selection, internal navigation, derived backlinks, deletion/rename and
reload/offline persistence. A real iOS/Android keyboard remains a device check;
desktop viewport emulation alone cannot prove its behavior.
