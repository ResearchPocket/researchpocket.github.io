# Capture and reading

Saving a URL commits the save locally. Retrieving metadata or capturing page
content is optional work after that save, so an offline or failed request does
not lose the link.

## Save the page you are reading

The bookmarklet invokes the installed native CLI through a per-user URL handler.
It needs a native installation on that computer; opening the hosted app alone
does not install the handler.

1. Install the CLI in a stable location and run `research init`.
2. Run `research capture install`, then `research capture status`.
3. Create a bookmark named **Save to ResearchPocket**.
4. Copy the single line in [bookmarklet.js](../../bookmarklet.js) into its URL field.
5. Open an HTTP(S) page and activate the bookmark.

The bookmarklet reads the already-loaded page's URL, title, description, and
language, and prompts for tags. Its prompt runs inside the page, so add sensitive
context later inside ResearchPocket. It never carries a token, enrichment
provider, or data-directory setting and does not run sync.

The [capture reference](../v2/CLI.md#browser-capture-through-the-url-scheme)
includes OS registration and troubleshooting. Remove the handler with
`research capture uninstall` when you no longer need it.

## Fill missing metadata

Use direct fetching for public HTML:

```sh
research add https://example.com/article --enrich direct
research enrich configure direct --on-capture
research enrich run
research enrich status
```

Direct fetching fills eligible missing title, excerpt, and language values; it
does not retain an entire page. Enrichment leaves private notes, tags, favorites,
and your authored values alone. An empty merged-text excerpt can still be
eligible for filling; see the [exact replacement rules](../v2/CLI.md#metadata-enrichment).

An unsuccessful request leaves a durable retryable job. The browser app does
not expose provider configuration or run enrichment requests; configure and run
the provider with the native CLI/TUI.

## Capture Markdown with Firecrawl

Firecrawl is an explicit hosted extractor. Choosing it sends the saved URL to
the configured Firecrawl service. Keep its credential local:

```sh
printf '%s' "$FIRECRAWL_API_KEY" | \
  research enrich configure firecrawl --api-key-stdin --on-capture
research enrich run "$ITEM_ID" --provider firecrawl
```

Firecrawl stores bounded Markdown as a separate captured document associated
with the save. In 2.3.0 the complete page stays outside the excerpt. An excerpt
comes from the page's bounded description or Markdown lead, and an existing
authored excerpt is replaced only with explicit `--replace-excerpt` consent:

```sh
research enrich run "$ITEM_ID" --provider firecrawl --replace-excerpt
```

That flag still writes a bounded description, not the whole Markdown page.
Older whole-page excerpts remain until explicitly re-enriched. See the
[2.3.0 release notes](../releases/v2.3.0.md) for the upgrade behavior.

## Read a captured page

Open a save in the browser Reader. Your excerpt appears first. If there is a
capture, expand **Captured page** to see its content, provider, date, and size.
If no excerpt exists, the capture opens automatically. Capture bytes load only
when the section is opened; a library list does not fetch every page body.

The native client that fetched a capture has its Markdown locally. A new browser
may need its private sync connection to retrieve a capture it has not cached.
Having a saved URL or synced item metadata does not guarantee all page bodies
are already available offline. A failed capture load leaves the save and excerpt
usable.

The Reader supports Markdown, code, and mathematical notation. Images remain
inert until you explicitly allow them for that item; doing so contacts their
HTTPS hosts. The choice lasts only while that Reader is open. It does not copy
images into the library or sync an image permission. Zen currently renders its
own Markdown and task lists; Reader math and image controls are not Zen features.

## Remove a captured page

```sh
research enrich forget "$ITEM_ID"
```

This drops the item's capture reference and removes the local Markdown when no
other save uses that hash. The save, excerpt, note, and tags stay available.
Content already uploaded remains in immutable repository history; this command
is not remote secure erasure. Read [Data, sync, and privacy](../v2/DATA_AND_PRIVACY.md)
for recovery and retention.
