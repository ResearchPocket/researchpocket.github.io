# ResearchPocket V2 CLI

Status: local command and output contract

The shipped CLI is the V2 surface:

```text
research init
research add <URL>
research edit <ITEM_ID>
research delete <ITEM_ID>
research restore <ITEM_ID>
research import v1 <SOURCE_DB>
research list
research search <QUERY>
research status
```

GitHub synchronization, scheduled synchronization, GitHub Pages owner editing,
and V2 publication are not implemented in this slice. Git is not used to resolve
application changes.

## Global options

```text
--data-dir <DIR>
--format human|json|ndjson
```

Global options may appear before or after a subcommand. V2 resolves its library
directory in this order:

1. `--data-dir <DIR>`
2. `RESEARCHPOCKET_DATA_DIR`
3. the operating system's local application-data directory

The usual defaults are:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/researchpocket`
- macOS: `~/Library/Application Support/io.github.ResearchPocket.ResearchPocket`
- Windows: `%LOCALAPPDATA%\ResearchPocket\ResearchPocket\data`

The local database is `<data-dir>/library.sqlite3`. It contains private local
state and must not be committed, uploaded, placed in a public-output directory,
or copied as a synchronization mechanism. Future synchronization exchanges
immutable CRDT update envelopes instead of SQLite files.

## Initialize

```sh
research init
```

Initialization creates a library and device identity, applies the V2 schema, and
prints the resolved location. It is idempotent for an existing valid V2 library.
It refuses to overwrite a nonempty directory that is not a V2 library.

## Capture

```sh
research add https://example.com/article
research add https://example.com/article \
  --title "Worth reading" \
  --excerpt "Human-authored context" \
  --tag reading,rust \
  --favorite \
  --note "Come back to section three"
```

Capture is immediate and makes no network request. Only the URL is required.
Title, excerpt, language, note, favorite state, tags, and an optional original
`--saved-at <UNIX_SECONDS>` value are stored exactly as supplied. Saving the same
URL twice creates two distinct items.

## Edit and lifecycle

Use the UUID shown by `research list`:

```sh
research edit "$ITEM_ID" --title "A deliberate title" --favorite true
research edit "$ITEM_ID" --note "" --add-tag reviewed --remove-tag reading
research edit "$ITEM_ID" --clear-title --clear-excerpt --clear-language
research delete "$ITEM_ID"
research restore "$ITEM_ID"
```

`--title ""`, `--excerpt ""`, and `--language ""` store explicit empty text;
the corresponding `--clear-*` option stores absence. Tags retain exact spelling.
An edit may change several fields but commits as one local mutation and one
durable outbound batch. Delete is a recoverable lifecycle transition, not
physical erasure. Repeating delete on an already deleted item, repeating restore
on an active item, or submitting an empty edit fails without changing local
state or the outbox.

## Import V1

```sh
research import v1 /path/to/v1/research.sqlite
```

The importer copies the database and supported SQLite sidecars into a private
staging area, reads only that staged copy, ignores the legacy `secrets` table,
deletes the staging area after use, and records a stable receipt for each
imported row. Repeating an import skips rows already accepted. Valid saves remain
imported when another field or record is malformed; migration diagnostics are
reported rather than silently discarded.

See [MIGRATION.md](./MIGRATION.md) for preservation and recovery details.

## List

```sh
research list
research list --tags rust,sqlite --favorite-only
research list --limit 100 --offset 100
research list --all --include-deleted
```

The default page contains at most 50 active saves. Results are ordered by saved
time descending and then item ID ascending. Tags use AND semantics: an item must
contain every requested tag.

The human view is compact. JSON and NDJSON expose materialized item fields but
never raw CRDT containers, causal revisions, update payloads, or credentials.

## Search

```sh
research search rust
research search 'rust sqlite' --favorite-only
research search 'local*' --tags research --limit 20
research search '"exact phrase"' --include-deleted
```

Search is entirely local and covers URL, title, excerpt, private note text, and
tags through the rebuildable SQLite FTS5 projection. Space-separated terms use
FTS AND semantics; quoted phrases and `*` prefix queries are supported. Exact tag
filters are applied in addition to the full-text query. Results rank by FTS
relevance, then saved time descending and item ID ascending. Deleted items remain
hidden unless `--include-deleted` is supplied.

Opening a library created before the search migration builds its index from the
existing materialized items. Create, import, and edit transactions update the
index atomically; a failed or read-only search never changes the canonical state,
outbox, or device sequence. Invalid query syntax returns a sanitized input error.

## Status

```sh
research status
```

Status is safe before initialization and reports `initialized: false`. For an
initialized library it shows library and device identities, active and deleted
item counts, import summaries, pending outbox count, and synchronization state.
Until the remote adapter ships, synchronization reports `not_configured`.

## Output contract

Human output and machine data go to stdout. Progress, warnings, and import
diagnostics go to stderr. Machine timestamps use RFC 3339 UTC. A top-level
`schema_version` versions CLI output independently of library and synchronization
protocol versions.

Create, edit, delete, and restore JSON output use the same materialized item
shape as list entries, plus top-level `schema_version` and `command` fields. They
do not expose causal revisions, CRDT bytes, or transport payloads.

JSON list output has one document:

```json
{
  "schema_version": 1,
  "command": "list",
  "page": { "total": 1, "offset": 0, "returned": 1 },
  "items": [
    {
      "id": "019...",
      "url": "https://example.com",
      "title": "Example",
      "excerpt": null,
      "note": null,
      "favorite": false,
      "language": "en",
      "saved_at": "2025-08-30T12:00:00Z",
      "tags": ["research"],
      "state": "active"
    }
  ]
}
```

NDJSON list output starts with a page record and then emits one item record per
line:

```json
{"schema_version":1,"type":"list_page","total":1,"offset":0,"returned":1}
{"schema_version":1,"type":"item","item":{"id":"019...","url":"https://example.com"}}
```

JSON search output adds the normalized `query` beside the same `page` and
`items` fields. NDJSON uses a `search_page` first record containing that query,
followed by the same item records.

Do not parse human output in integrations. The JSON and NDJSON schemas are the
machine interfaces and require an explicit compatibility plan before a breaking
change.
