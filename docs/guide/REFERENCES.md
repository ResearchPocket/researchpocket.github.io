# Documentation and references

Use ResearchPocket to keep documentation, papers, tutorials, and examples close
to the work they support. Save the original URL as a source, record why it
matters, and link to that save from a Zen document when you want to build an
argument or plan.

## Save a documentation page as a source

Save the page you will actually need: a versioned API page, a particular guide,
or a paper's landing page rather than only a project's home page.

```sh
research add https://example.com/docs/v3/retries \
  --title "Retries — API v3" \
  --tag project-sync,reference \
  --note "Check the timeout example before changing our retry loop"
```

Replace the example URL with your real source. Tags connect related sources;
the private note preserves your reason for saving this one. Keep the source's
version or date in the title or note when that affects your work.

A saved URL is not an offline copy of an entire documentation site. Enrichment
and [captured pages](READING.md#read-a-captured-page) apply to individual saved
pages. There is no site crawler, PDF attachment manager, or bibliography importer.

## Choose the right place for context

| What you want to keep | Use |
| --- | --- |
| A useful external source | A saved URL |
| A short summary or selected context from the source | The editable excerpt |
| Why the source matters to your work | The save's private note |
| A fetched Markdown version of one page | An optional Firecrawl captured page |
| Your synthesis, questions, or reading checklist | A Zen document |
| A reference that follows a saved item's current title | A `research:item/<uuid>` mention |
| A link to another Zen document in the current browser | A `research:zen/<uuid>` link inserted through completion or Markdown |
| A normal link outside your saved library | A standard Markdown HTTPS link |

Enrichment does not author your notes or organize your research. You choose
which sources belong together and what you want to say about them.

## Build a reading plan with saved-item references

First save your sources. Then run `research list` to get their UUIDs and create
a Zen document containing, for example:

```markdown
# Retry design: reading plan

## Sources

- [API retry reference](research:item/01900000-0000-7000-8000-000000000001)
- [Worked example](research:item/01900000-0000-7000-8000-000000000002)

## Questions

- [ ] Compare the timeout defaults in both sources
- [ ] Check which failures are safe to retry
- [ ] Record the decision in the project

## Working notes

Keep observations here and verify them against the original pages.
```

Replace both example IDs with actual saved-item IDs. A mention is a link to one
save, so the same URL saved twice still has two different identities. Use the
one that carries the context you intend to reference.

The [Zen guide](ZEN.md#reference-a-saved-item) explains live titles, deleted
sources, unknown IDs, and browser/TUI editing. There is no automatic citation
formatting or footnote manager.

## Connect documents and return to their sources

In the current browser update, type `[[` in a Zen body to find an existing save
or document, or choose **Insert link** on a phone. The picker inserts the UUID
link without requiring you to copy an ID. Use a document link to connect a
reading plan to your synthesis, and saved-item links for the original sources.

Open a document or save and look at **Linked from** to find the live documents
referencing it. Backlinks are read from local Markdown while you view the
target. You do not maintain a separate index, and no backlink structure is
uploaded. These browser additions are beyond published 2.3.0; see
[Zen links and backlinks](ZEN.md#insert-links-and-follow-backlinks) for controls
and older-reader behavior.

## Find sources and explore connections

Search the Library by title, URL, context, or tags. Use favorites for sources
you return to frequently and tags for project or topic groupings. The Library's
**Graph** view uses the same filtered saves as **List**.

Graph connections come from two explicit relationships: a save carries a tag,
or two saves are mentioned in the same Zen document. Documents themselves are
not graph nodes. Co-mention links are derived when you open the graph; they do
not change source data or invent semantic relationships. Very large mention
lists are capped, and the UI reports the limit.

For a focused graph, narrow the Library search or tags first. Switching back to
List keeps the filter. See [Save and organize sources](LIBRARY.md#explore-the-library-graph)
for controls and limits.

## Keep private references usable on another device

Sources and Zen documents synchronize through your private data repository.
A synced reference resolves after its saved item is present locally. A bare
`research:item/…` reference sent to someone else does not grant access to your
library. ResearchPocket does not currently publish collections or Zen documents.

Use [Sync and recovery](SYNC.md) to connect another device and
[Capture and reading](READING.md) to understand which page content is available
offline. For ResearchPocket's own implementation documentation, go to the
[technical reference](TECHNICAL.md).
