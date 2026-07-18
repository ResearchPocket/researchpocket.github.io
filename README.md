# ResearchPocket

ResearchPocket is a URL-first, local-first personal library. V2 keeps saves under
your control, supports deliberate human organization, and uses application-level
CRDT convergence so a private GitHub repository can remain storage and transport
rather than a conflict resolver.

**V2 preview:** [understand the product](https://researchpocket.github.io/)
· [open the owner app](https://researchpocket.github.io/app/)
· [download the CLI](https://github.com/ResearchPocket/researchpocket.github.io/releases)

This is a preview release, not V2 GA. The available workflows and remaining
boundaries are listed below and in the
[preview release guide](docs/releases/v2.0.0-preview.3.md).

## Current V2 CLI

The V2 CLI initializes a private local library, captures and curates saves fully
offline, imports an existing V1 ResearchPocket database, searches local state,
and synchronizes immutable updates through a private GitHub repository:

```sh
research init
research add https://example.com/article --tag reading
research add https://example.com/article --enrich direct
research enrich status
research capture install
research import v1 /path/to/v1/research.sqlite
research list
research search 'rust sqlite'
research tui
research edit "$ITEM_ID" --title "A better title" --favorite true
research delete "$ITEM_ID"
research restore "$ITEM_ID"
research sync connect OWNER/PRIVATE_REPOSITORY
research sync run
research status
```

The old Pocket-era command surface is no longer part of the shipped binary.
Pocket authentication, fetching, and mutations are retired with Mozilla's Pocket
service. Historical implementation remains available through Git history; V1
data compatibility lives only in the read-only importer.

## Install the V2 preview

The `v2.0.0-preview.3` release provides archives for Apple Silicon and Intel
macOS, Linux amd64, and Windows amd64, plus `SHA256SUMS`. Download the archive
for your platform from the [release page](https://github.com/ResearchPocket/researchpocket.github.io/releases),
verify it, place `research` (or `research.exe`) somewhere stable on your `PATH`,
then run:

```sh
research --version
research init
research status
```

On macOS, native capture binds the current executable location into its local
application bridge, so install the binary at its long-term path before running
`research capture install`. The complete archive names and setup sequence are in
the [release guide](docs/releases/v2.0.0-preview.3.md).

## Build from this repository

```sh
cargo build --locked --release
./target/release/research --help
```

## Library location

ResearchPocket uses the operating system's local application-data directory by
default:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/researchpocket`
- macOS: `~/Library/Application Support/io.github.ResearchPocket.ResearchPocket`
- Windows: `%LOCALAPPDATA%\ResearchPocket\ResearchPocket\data`

Override it for a separate library or a temporary test:

```sh
research --data-dir /path/to/private/library init
```

`RESEARCHPOCKET_DATA_DIR` provides the same override. The local
`library.sqlite3` contains private state. Do not commit, upload, publish, or copy
it as a synchronization mechanism.

## Save the current Firefox page through the CLI

ResearchPocket can register the installed V2 CLI as a per-user handler for the
`researchpocket://` scheme. This is a local bridge from Firefox to the same
offline mutation used by `research add`; it does not require a browser extension,
running server, GitHub credential, or network connection.

Put the `research` binary at its long-term location, initialize the library that
Firefox should use, and install the handler:

```sh
research init
research capture install
research capture status
```

When using a non-default library, select it while installing. The resolved
absolute data directory is written into the per-user handler, because a program
started by Firefox does not inherit the environment of an existing terminal:

```sh
research --data-dir /absolute/path/to/private/library capture install
```

`RESEARCHPOCKET_DATA_DIR` is also resolved at installation time. The data
directory stays in the local operating-system registration and is never placed
in the bookmarklet or capture URI.

To add the bookmarklet in Firefox:

1. Show the Bookmarks Toolbar, right-click it, and choose **Add Bookmark**.
2. Name the bookmark `Save to ResearchPocket`.
3. Copy the complete single line from [bookmarklet.js](bookmarklet.js) into the
   bookmark's **URL** or **Location** field.
4. Open a page and click the bookmarklet. On the first use, allow Firefox to open
   the link with ResearchPocket; Firefox may offer to remember that choice for
   the site.
5. Confirm the local result with `research list`.

The standard bookmarklet sends protocol version 2, the current HTTP(S) URL, page
title, and any bounded description/language metadata already present in the
loaded DOM. The CLI validates and saves them locally as one normal V2 item and
one durable outbox update. The bookmarklet performs no metadata request and does
not silently deduplicate a URL. Version 1 bookmarklets remain accepted.

Capture does not upload anything. Run `research sync run`, or keep the optional
foreground `research sync run --every 60` loop active, when you want queued
captures to reach the configured private repository.

Installation is idempotent and refreshes the registered executable and library
paths. Re-run it after moving the binary or changing the library. On macOS, also
re-run it after every CLI upgrade so the application bridge contains the current
binary. Remove only the current user's protocol registration with:

```sh
research capture uninstall
```

Uninstalling the handler does not delete the Firefox bookmark or any saved data.
See the [complete capture and troubleshooting guide](docs/v2/CLI.md#firefox-bookmarklet-capture)
and [privacy boundary](docs/v2/THREAT_MODEL.md#native-bookmarklet-capture). The
custom-scheme decision and alternatives are recorded in
[ADR 0001](docs/v2/ADR_0001_NATIVE_BROWSER_CAPTURE.md).

## Optional metadata enrichment

Saving stays URL-first: ResearchPocket commits the item before contacting a
page or extraction service. A failed request therefore leaves the save intact
and a bounded local retry job. Fetched metadata fills only title, excerpt, and
language fields whose exact missing-field revisions are still current; authored
values, including a clear, an explicit empty string, or a concurrent edit from
another client, always win. Short-lived local leases prevent concurrent CLI
processes from sending the same queued request twice.

Use the built-in direct HTML extractor for one save or make it the browser
capture default:

```sh
research add https://example.com/article --enrich direct
research enrich configure direct --on-capture
research enrich run
research enrich status
```

Firecrawl is an explicit alternative for pages whose useful metadata needs a
hosted extractor. The URL is sent to Firecrawl. ResearchPocket calls the small
REST scrape endpoint with its existing HTTP client; it does not depend on the
Firecrawl Cargo package. Pass the key through standard input so it never appears
in shell history:

```sh
printf '%s' "$FIRECRAWL_API_KEY" | \
  research enrich configure firecrawl --api-key-stdin --on-capture
research add https://example.com/article --enrich firecrawl
research enrich run
research enrich disable
```

The optional key file is separate from SQLite, CRDT updates, and the sync
repository. It is created with owner-only mode on Unix; on Windows it inherits
the selected data directory's access controls, so keep a custom data directory
restricted to the owner. `FIRECRAWL_API_KEY` may instead be supplied to the
current process. Only normalized title, excerpt, and language are retained;
HTML, Markdown, PDFs, and page files are not archived. The complete contract is
in [the CLI guide](docs/v2/CLI.md#metadata-enrichment) and
[ADR 0002](docs/v2/ADR_0002_LINK_ENRICHMENT.md).

## Migrate an existing library

The importer stages a private copy and never opens the source database as its
working database. It never queries or imports legacy secrets, deletes the staging
copy after use, preserves supported save fields and exact tag spelling, reports
malformed fields or records, and records per-row receipts so a repeated import is
idempotent.

For the recovered library in this workspace:

```sh
export RESEARCHPOCKET_DATA_DIR="$HOME/Developer/pocket/recovered/i-like-to-save-it-save-it-2025-08-30/v2-library"
research init
research import v1 \
  "$HOME/Developer/pocket/recovered/i-like-to-save-it-save-it-2025-08-30/current-db/research.sqlite"
research status
research list --limit 20
```

See the [migration guide](docs/v2/MIGRATION.md) for preservation and recovery
details.

## Synchronize privately without a backend

Create an empty private GitHub repository and a fine-grained PAT limited to that
repository with `Contents: read/write` and an expiry of at most 90 days. Keep the
PAT out of shell history by reading it silently in Bash or Zsh, exporting it
only while the sync commands run, and then removing it from the shell:

```sh
printf 'Fine-grained GitHub token: ' >&2
IFS= read -r -s RESEARCHPOCKET_GITHUB_TOKEN
printf '\n' >&2
export RESEARCHPOCKET_GITHUB_TOKEN
research sync connect OWNER/PRIVATE_REPOSITORY
research sync run
unset RESEARCHPOCKET_GITHUB_TOKEN
```

Repeat the silent read and export in a new shell before a later sync. Run the
`unset` command after use even when a sync command reports an error.

The first command creates immutable protocol genesis, drains the durable outbox,
and verifies the final remote state. For another device, run `research init` in
a fresh data directory and connect it to the same repository; a pristine device
adopts the remote library identity and rebuilds its local database while keeping
a unique device identity.

`research sync run --every 60` provides an optional foreground periodic loop.
Network, rate-limit, server, and branch-head failures retain the exact queued
updates for retry. Git commits and their order never choose field values, and
the CLI never asks you to merge or rebase saves. See the complete
[CLI workflow](docs/v2/CLI.md#private-github-synchronization) and
[sync protocol](docs/v2/SYNC_PROTOCOL.md).

## Hosted owner application

The V2 static owner app now runs the same Rust domain core through WASM and
keeps its private replica in IndexedDB. Capture, search, edit, favorite, tag,
delete, and restore work offline; each action creates one durable outbox update
in the same browser transaction as the new snapshot and projection.

```sh
cd web
npm ci
npm run dev
```

The [public product overview](https://researchpocket.github.io/) loads no private
application state. The separate
[owner app](https://researchpocket.github.io/app/) is deployed as a
credential-free GitHub Pages shell. Its
Private sync panel connects a separate private data repository with an expiring,
repository-scoped fine-grained PAT. The browser pulls on startup, focus, network
recovery, and every 60 seconds while visible; local changes also request a sync.
The Sync view lists every durable outgoing browser change until GitHub
acknowledges its immutable update; older queued entries remain visible with a
generic label when detailed local summaries are unavailable.
The token stays in JavaScript memory unless the owner explicitly chooses
tab-only `sessionStorage`, and it never enters IndexedDB, URLs, logs, or the
service-worker cache.

The canonical Pages origin is `https://researchpocket.github.io/`. The former
`/ResearchPocket/` project paths remain as same-origin compatibility redirects,
so existing bookmarks and `#restore` links continue to the root deployment.
Because the origin does not change, the new `/app/` entry uses the same
browser-local IndexedDB library as the former project-path owner app.

For an existing synchronized library, choose **Restore from private sync** before
creating a save in the browser. The app prepares a pristine browser replica,
opens the Sync view, adopts the remote library identity, and rebuilds the local
view from immutable updates. See the [hosted application contract](docs/v2/WEB.md).

## Terminal interface

Run `research tui` from an interactive terminal to manage the selected local V2
library without a network request. It uses the same `V2Store` transactions as the
CLI, so capture, edit, favorite, delete, and restore each atomically update the
CRDT snapshot, SQLite projection, and durable outbox.

The main shortcuts are `a` to capture, `e` or Enter to edit, `/` to search, Space
to toggle favorite, `x` to delete, `r` to restore, `f` to filter favorites, and
`d` to cycle active/all/deleted views. Press `?` for complete keyboard help.
Forms use Tab and Shift+Tab between fields, `Ctrl+N` for a note newline, and
`Ctrl+S` to save one mutation. Use `q` from the library or `Ctrl+C` anywhere to
exit and restore the terminal.
The footer shows pending outbox and synchronization state but the TUI never reads
a GitHub token or starts synchronization.

## Human and machine output

Every command accepts `--format human|json|ndjson`. Options are global and may be
placed before or after a command:

```sh
research status --format json
research list --format ndjson --all > saves.ndjson
research list --tags rust,sqlite --favorite-only
```

Machine data goes to stdout. Progress, warnings, and import diagnostics go to
stderr. JSON and NDJSON output is schema-versioned; raw CRDT containers,
transport updates, and credentials are never list output.

The complete command and output contract is in [docs/v2/CLI.md](docs/v2/CLI.md).

## Current boundary

The CLI and hosted owner UI support private GitHub synchronization and
new-device restoration. The TUI supports local capture, curation, search, and
recoverable lifecycle management. Installed background scheduling, checkpoints,
the loopback local web server, and selective V2 publication are not implemented
yet.

Clients exchange immutable CRDT update batches. Git commits, branches, merges,
rebases, timestamps, and last-push order never choose application values or
require the owner to resolve library conflicts.

## Development

The engineering and privacy contract is in [AGENTS.md](AGENTS.md), with the V2
[product contract](docs/v2/PRODUCT.md),
[synchronization protocol](docs/v2/SYNC_PROTOCOL.md),
[hosted application contract](docs/v2/WEB.md),
[design system](docs/v2/DESIGN_SYSTEM.md),
[privacy threat model](docs/v2/THREAT_MODEL.md), and
[delivery roadmap](docs/v2/ROADMAP.md) alongside this CLI slice.

Use the smallest relevant verification while iterating. Tests are intentionally
sparse and protect only essential persistence, migration, convergence, or privacy
contracts.
