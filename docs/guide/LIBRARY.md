# Save and organize sources

The Library holds saved HTTP(S) URLs and their context. A save has its own UUID,
so saving the same URL twice creates two separate items. ResearchPocket never
silently combines them.

## Save and edit a URL

In the browser, open **Library** and paste an absolute HTTP(S) URL into the
search/save field. Submit the offered save action; ordinary search text filters
the library instead. On a small screen, **Save a link** opens capture.

Open a save for the Reader and choose **Edit save** to change its context. Titles,
excerpts, private notes, tags, and favorite state are yours to curate. Editing a
save does not retrieve the page again.

From the CLI:

```sh
research add https://example.com/article \
  --title "Concurrency reference" --tag rust,project --favorite
research list
research edit "$ITEM_ID" --note "Compare with the prototype" --add-tag reviewed
```

For saving the page already open in another browser tab, install the
[bookmarklet bridge](READING.md#save-the-page-you-are-reading).

## Search, tags, and favorites

The browser's **Filters** control exposes search fields, lifecycle, sort order,
and favorites. Search can cover all fields or narrow to title, URL, context,
or tags. Tag selection can match any or all selected tags. **Newest**,
**Oldest**, and **Title** control ordering.

Use short tags that match how you look for sources, such as `project-sync`,
`reference`, or `to-read`. A tag is a grouping label; it does not publish an
item or create a separate copy.

Native search uses SQLite full-text search:

```sh
research search concurrency
research list --favorite-only
research list --format ndjson --all
```

The [CLI reference](../v2/CLI.md) covers native filters and query behavior.
The Zen document list has its own metadata filter; it is not the Library search
and does not search every document body.

## Read a save

The Reader shows your excerpt first and keeps a captured page in a separate
**Captured page** section. Your private note remains item context. Open the
original URL when you need the current source, and use **Edit save** for your
own context. [Capture and reading](READING.md) explains what is stored, fetched,
and available offline.

## Explore the library graph

Switch **List** to **Graph** in the Library. On mobile, use **Graph** in the
bottom navigation. Search, tags, favorites, and lifecycle filters select the
same set of saves in both modes.

The graph has saved-item nodes and tag hubs. Tag membership connects a save to
a tag. Two saves mentioned in the same Zen document can also be connected.
These are derived relationships from your own tags and references; the graph
does not automatically classify a page. Zen documents are not graph nodes.

Use the graph's controls to fit, zoom, and focus. **0** fits the graph,
**+ / -** zoom, and **C** focuses the selection. Narrow your filters if the
view asks for fewer nodes: its ceiling is 5,000 on desktop and 400 on mobile.
Co-mention expansion is bounded to 24 distinct saves per document, with excess
reported in the view. The graph layout is local presentation state.

## Delete, undo, and restore

Browser item mutations offer an **Undo** action, also reachable with **Ctrl+Z**
or **Cmd+Z**. It applies a new change and is available for the latest eligible
item action in the current session. A later local or remote change can make it
stale. It is not a history browser for all actions or Zen documents.

Deleted saves remain recoverable. In the browser, use the deleted lifecycle
filter and restore the item. Native commands are:

```sh
research delete "$ITEM_ID"
research restore "$ITEM_ID"
```

In the TUI, **d** cycles lifecycle views, **x** asks to delete, and **r**
restores. See [Data, sync, and privacy](../v2/DATA_AND_PRIVACY.md) for why
recoverable deletion does not erase immutable repository history.
