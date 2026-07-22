# Getting started with ResearchPocket

ResearchPocket is a private, local-first library for useful links. Save a URL
with the title, note, tags, and context that matter to you; search and curate it
offline; and optionally synchronize immutable updates through a private GitHub
repository.

Your library belongs to the application, not to Git history. GitHub provides
private storage and transport, while ResearchPocket resolves concurrent changes
without asking you to merge or rebase personal data.

[Open the owner app](https://researchpocket.github.io/app/) ·
[Read the product overview](https://researchpocket.github.io/overview/) ·
[Download the CLI](https://github.com/ResearchPocket/researchpocket.github.io/releases) ·
[Browse the reference](https://researchpocket.github.io/docs/)

## Start here

Choose the interface that fits where you are working.

### Use the owner app

Open [researchpocket.github.io/app/](https://researchpocket.github.io/app/) in a
modern browser.

- Choose **Start a new library** for an empty, device-local library.
- Choose **Restore from private sync** before creating a save when another
  ResearchPocket installation already uses your private repository.
- Capture, search, edit, tag, favorite, archive, restore, and read saved context
  offline.
- Connect private sync only when you want this browser to exchange updates with
  your other installations.

The owner app stores its private replica in IndexedDB. It has no ResearchPocket
account, analytics, hosted application database, or bundled public library.

### Use the CLI

Download the archive for your platform from the
[release page](https://github.com/ResearchPocket/researchpocket.github.io/releases),
verify it against `SHA256SUMS`, and place `research` (or `research.exe`) somewhere
stable on your `PATH`.

Initialize the local library:

```sh
research --version
research init
research status
```

The release page provides archives for Apple Silicon and Intel macOS, Linux
amd64, and Windows amd64. The binaries are not code-signed or notarized. Build
the reviewed source instead of weakening system-wide security when your platform
does not accept an archive.

To build locally:

```sh
cargo build --locked --release
./target/release/research --help
```

## Save and find your first link

Only the URL is required:

```sh
research add https://example.com/article
research list
research search example
```

Add context at capture time when it is already clear why the link matters:

```sh
research add https://example.com/article \
  --title "Worth reading" \
  --tag reading,rust \
  --note "Return to the concurrency section" \
  --favorite
```

Use the item ID from `research list` to curate or recover a save:

```sh
research edit "$ITEM_ID" --title "A clearer title" --add-tag reviewed
research delete "$ITEM_ID"
research restore "$ITEM_ID"
```

Saving the same URL twice creates two separate items. ResearchPocket never
silently deduplicates authored saves.

## Library location and privacy

The CLI uses the operating system's local application-data directory by default:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/researchpocket`
- macOS: `~/Library/Application Support/io.github.ResearchPocket.ResearchPocket`
- Windows: `%LOCALAPPDATA%\ResearchPocket\ResearchPocket\data`

Use a separate directory for another library or a temporary test:

```sh
research --data-dir /path/to/private/library init
```

`RESEARCHPOCKET_DATA_DIR` provides the same override. The local
`library.sqlite3` contains private state. Do not commit, upload, publish, or copy
it as a synchronization mechanism.

## Save from a browser

The installed CLI can register a per-user `researchpocket://` handler with the
operating system. The handler is not tied to Firefox: a browser, bookmarklet, or
other local integration can dispatch a valid capture URI to the same offline save
operation as `research add`. It does not require an extension, running server,
GitHub credential, or network connection.

The supplied bookmarklet works in browsers that allow a JavaScript bookmark to
hand a custom URL scheme to the operating system. Bookmark and external-protocol
permission controls vary by browser.

1. Put the CLI at its long-term location and run `research init`.
2. Run `research capture install`, then confirm it with
   `research capture status`.
3. Create a browser bookmark named `Save to ResearchPocket` and copy the complete
   single line from [bookmarklet.js](bookmarklet.js) into its URL field. In
   Firefox, use **Bookmarks Toolbar → Add Bookmark**.
4. Open a page, click the bookmarklet, and optionally enter comma-separated
   tags.
5. Confirm the local result with `research list`.

When using a non-default library, bind it during installation:

```sh
research --data-dir /absolute/path/to/private/library capture install
```

The tag prompt runs in the open page's untrusted JavaScript context. Use it only
for non-sensitive organizational tags; add private tags later through the CLI,
TUI, or owner app. Capture remains local until you explicitly run sync.

Re-run installation after moving or replacing the binary. On macOS, reinstall
after every CLI upgrade because the per-user application bridge contains its own
copy. Remove the association without deleting saved data with:

```sh
research capture uninstall
```

See the [capture and troubleshooting reference](docs/v2/CLI.md#browser-capture-through-the-url-scheme)
and [capture privacy boundary](docs/v2/THREAT_MODEL.md#native-bookmarklet-capture).

## Add metadata after capture

Enrichment is optional and always runs after the URL is durable. A failed or
offline request leaves the save intact and retryable. Fetched data fills only
eligible title, excerpt, and language fields; authored values and concurrent
human changes win.

Use the built-in public-HTML extractor:

```sh
research add https://example.com/article --enrich direct
research enrich configure direct --on-capture
research enrich run
research enrich status
```

Firecrawl is an explicit alternative for pages that need a hosted extractor.
Selecting it sends the saved URL to the configured Firecrawl service. Keep the
credential out of shell history by passing it through standard input:

```sh
printf '%s' "$FIRECRAWL_API_KEY" | \
  research enrich configure firecrawl --api-key-stdin --on-capture
research enrich run
```

The optional key file remains separate from the library and synchronization
data. Firecrawl Markdown is bounded and stored through the normal excerpt field;
raw HTML, PDFs, and attachments are not archived. See the
[enrichment reference](docs/v2/CLI.md#metadata-enrichment) for replacement,
retry, provider, and privacy details.

## Import an existing library

The importer reads a private staging copy of an existing ResearchPocket SQLite
database. It does not modify the source, import retired credentials, or silently
discard malformed records. Per-row receipts make repeated imports idempotent.

```sh
export RESEARCHPOCKET_DATA_DIR="$HOME/path/to/new-library"
research init
research import v1 "$HOME/path/to/previous/research.sqlite"
research status
research list --limit 20
```

Keep the source and a verified backup until you have checked counts and several
representative saves. See the [migration guide](docs/v2/MIGRATION.md) for field
preservation and recovery details.

## Synchronize privately

Synchronization is optional. Create an empty private GitHub repository and an
expiring fine-grained token limited to that repository with
`Contents: read/write`.

Read the token silently, expose it only while the commands run, and remove it
from the shell afterward:

```sh
printf 'Fine-grained GitHub token: ' >&2
IFS= read -r -s RESEARCHPOCKET_GITHUB_TOKEN
printf '\n' >&2
export RESEARCHPOCKET_GITHUB_TOKEN
research sync connect OWNER/PRIVATE_REPOSITORY
research sync run
unset RESEARCHPOCKET_GITHUB_TOKEN
```

For another device, initialize a fresh data directory and connect it to the same
repository before adding local saves. The device adopts the existing library
identity, keeps its own device identity, and rebuilds local state from immutable
updates.

Run `research sync run --every 60` for an optional foreground polling loop.
Network, rate-limit, server, and branch-head failures keep exact queued updates
for retry. Git commits and their order never decide library values.

The owner app exposes the same workflow in its **Sync** view. Its token stays in
memory unless you explicitly choose tab-only `sessionStorage`; it never enters
IndexedDB, URLs, logs, or the service-worker cache. See the
[synchronization workflow](docs/v2/CLI.md#private-github-synchronization),
[protocol reference](docs/v2/SYNC_PROTOCOL.md), and
[threat model](docs/v2/THREAT_MODEL.md).

## Use the terminal interface

Run `research tui` from an interactive terminal to capture, search, edit,
favorite, archive, and restore saves using the same local transactions as the
CLI.

The primary shortcuts are:

| Key | Action |
| --- | --- |
| `a` | Capture a URL |
| `e` or Enter | Edit the selected save |
| `/` | Search |
| Space | Toggle favorite |
| `x` / `r` | Archive / restore |
| `f` | Toggle favorite-only results |
| `d` | Cycle active, all, and archived views |
| `?` | Open complete keyboard help |
| `q` | Exit from the library view |

The TUI is offline. It reports pending synchronization state but does not read a
GitHub token or start synchronization.

## Use machine-readable output

Every data command accepts `--format human|json|ndjson`. Global options may
appear before or after a subcommand:

```sh
research status --format json
research list --format ndjson --all > saves.ndjson
research list --tags rust,sqlite --favorite-only
```

Machine data goes to stdout. Progress, warnings, and import diagnostics go to
stderr. Machine output is schema-versioned and never includes credentials, raw
CRDT state, or transport payloads.

## What is available now

ResearchPocket currently provides:

- offline capture, curation, search, archive, and restore through the CLI;
- an offline terminal interface built on the same local operations;
- a hosted owner app with browser-local editing and convergence-safe undo;
- native browser capture through an installed URL-scheme handler;
- optional direct or Firecrawl metadata enrichment;
- idempotent import from the previous SQLite library format;
- private GitHub synchronization and new-device restoration; and
- human, JSON, and NDJSON command output.

The following work is not currently shipped:

- background-service installation;
- synchronization checkpoints and history pruning;
- the loopback local web server; and
- selective publication and public collections.

## Reference

- [Complete CLI reference](docs/v2/CLI.md)
- [Migration guide](docs/v2/MIGRATION.md)
- [Hosted owner application](docs/v2/WEB.md)
- [Synchronization protocol](docs/v2/SYNC_PROTOCOL.md)
- [Privacy threat model](docs/v2/THREAT_MODEL.md)
- [Product contract](docs/v2/PRODUCT.md)
- [Design system](docs/v2/DESIGN_SYSTEM.md)
- [Delivery roadmap](docs/v2/ROADMAP.md)
- [Contributing guide](CONTRIBUTING.md)

## Development

Use the pinned Rust toolchain and locked dependencies:

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
cargo build --locked --release
```

For the public website and owner app:

```sh
cd web
npm ci
npm run verify
npm run dev
```

Tests are intentionally sparse and protect durable persistence, migration,
convergence, privacy, and deployment boundaries rather than implementation
details.
