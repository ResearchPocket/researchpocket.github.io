# ResearchPocket

ResearchPocket is a URL-first, local-first personal library. V2 keeps saves under
your control, supports deliberate human organization, and uses application-level
CRDT convergence so a private GitHub repository can remain storage and transport
rather than a conflict resolver.

## Current V2 CLI

The V2 CLI initializes a private local library, captures and curates saves fully
offline, imports an existing V1 ResearchPocket database, searches local state,
and synchronizes immutable updates through a private GitHub repository:

```sh
research init
research add https://example.com/article --tag reading
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
service. The old Rust modules remain in the repository only as migration
references.

## Install from this repository

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
PAT out of shell history by providing it through the process environment:

```sh
export RESEARCHPOCKET_GITHUB_TOKEN='github_pat_...'
research sync connect OWNER/PRIVATE_REPOSITORY
research sync run
```

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

The production build is deployed as a credential-free GitHub Pages shell. PAT
onboarding and browser pull/push are the next hosted-owner slice; this foundation
does not claim that browser-only changes are remotely backed up yet. See the
[hosted application contract](docs/v2/WEB.md).

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

The CLI supports private GitHub synchronization, new-device restoration, and an
optional foreground periodic loop. The TUI supports local capture, curation,
search, and recoverable lifecycle management. The static owner UI supports
offline local editing through the shared WASM core. Browser GitHub
synchronization, installed background scheduling, checkpoints, local web
management, and V2 publication are not implemented yet.

Clients exchange immutable CRDT update batches. Git commits, branches, merges,
rebases, timestamps, and last-push order never choose application values or
require the owner to resolve library conflicts.

## Development

The engineering and privacy contract is in [AGENTS.md](AGENTS.md), with the V2
[product contract](docs/v2/PRODUCT.md),
[synchronization protocol](docs/v2/SYNC_PROTOCOL.md),
[hosted application contract](docs/v2/WEB.md),
[privacy threat model](docs/v2/THREAT_MODEL.md), and
[delivery roadmap](docs/v2/ROADMAP.md) alongside this CLI slice.

Use the smallest relevant verification while iterating. Tests are intentionally
sparse and protect only essential persistence, migration, convergence, or privacy
contracts.
