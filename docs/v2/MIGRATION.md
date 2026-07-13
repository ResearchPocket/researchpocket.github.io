# Migrating a V1 library to the V2 alpha

V2 imports an existing ResearchPocket SQLite database into a new local library.
It does not upgrade the old database in place. Keep the V1 file as a recovery
backup until you have inspected the imported counts and several representative
saves.

## Before importing

Close processes that may still be writing the V1 database, then make a private
backup:

```sh
cp /path/to/research.sqlite /path/to/research.sqlite.backup
```

Do not publish either file. A V1 database may contain private notes and retired
Pocket credentials even though current ResearchPocket releases no longer use
those credentials.

Initialize the new library and import:

```sh
research init
research import v1 /path/to/research.sqlite
research status
research list --limit 20
```

For the recovered `i-like-to-save-it-save-it` library in this workspace, use:

```sh
export RESEARCHPOCKET_DATA_DIR="$HOME/Developer/pocket/recovered/i-like-to-save-it-save-it-2025-08-30/v2-library"
research init
research import v1 \
  "$HOME/Developer/pocket/recovered/i-like-to-save-it-save-it-2025-08-30/current-db/research.sqlite"
```

That recovered source contains 978 saves, 415 tags, and 2,439 item-tag links.
It contains no notes. Those counts are useful acceptance checks, not values the
importer hard-codes.

## Safety and idempotency

The importer:

- copies the source database and supported SQLite sidecars into a private
  staging area, then opens only the staged copy;
- checks the source before and after private snapshot creation and reports
  whether it changed during that operation;
- queries only known library tables and never queries or imports `secrets`; the
  byte-for-byte private staging snapshot necessarily contains every source table
  and is deleted when the import finishes;
- writes accepted V2 items and import receipts transactionally;
- assigns each imported save a V2 UUID independent of its URL or provider ID;
- records stable legacy-row identity so copying or moving the same source does
  not create duplicate imported records;
- skips a row already imported from that legacy identity;
- keeps distinct saves with the same URL instead of silently deduplicating them;
- imports valid data when another field or record produces a diagnostic; and
- reports diagnostic fields, codes, and reasons on stderr and in
  machine-readable results.

Running the same import again is expected and safe. A complete repeated import
reports zero newly imported rows and all accepted rows as skipped.

## Field preservation

| V1 field | V2 treatment |
| --- | --- |
| `items.uri` | Preserved as the saved URL |
| `items.title` | Preserved |
| `items.excerpt` | Preserved |
| `items.time_added` | Preserved as the original saved time |
| `items.favorite` | Preserved |
| `items.lang` | Preserved when present |
| `items.notes` | Preserved as private note text when present |
| `item_tags` / `tags` | Preserved with exact spelling |
| provider and legacy item ID | Retained only as local import provenance |
| `secrets` | Never read or imported |

Older schema variants may lack the `notes` column. That absence is represented as
an empty optional value; the importer does not alter the source to add the column.
Other columns from the original V1 item schema are required. A field that V1
never retained, such as an archive state absent from the schema, cannot be
recovered and is not fabricated.

## Machine-readable verification

Use JSON to capture an import receipt:

```sh
research import v1 /path/to/research.sqlite --format json \
  > import-result.json
```

The result includes `source_sha256` for the main database bytes,
`source_bundle_sha256` for the database plus present SQLite sidecars, whether the
source remained unchanged during snapshot creation, and `scanned`, `imported`,
`skipped`, `rejection_count`, and distinct-tag counts. Diagnostics stay on
stderr, so redirected JSON remains valid.

Then inspect local state:

```sh
research status --format json
research list --format ndjson --all > saves.ndjson
```

The generated files contain private library data. Store them as private backups,
not public publication artifacts.

## Current alpha boundary

Migration first creates a local V2 library. Connect that library through the CLI
or hosted owner's Private sync panel to upload immutable CRDT envelopes to a
separate private data repository. A pristine CLI or browser device can then
adopt the repository's library identity and restore all saves. Never synchronize
`library.sqlite3` through Git; Git merge behavior does not resolve library
changes.
