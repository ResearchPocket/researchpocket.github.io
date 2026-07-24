# ResearchPocket

Research work leaves a trail of links: papers to read, sources to cite, examples
to study, and ideas you do not want to lose. ResearchPocket gives those links one
private place on your own device.

It is useful for a class, a thesis, learning a new field, or working through a
long and ambitious project. Save a URL, add a note about why it matters, tag it,
and find it again later. You can use it without an account or an internet
connection. GitHub sync and page enrichment are optional.

[Open the browser app](https://researchpocket.github.io/app/) |
[Download the CLI](https://github.com/ResearchPocket/researchpocket.github.io/releases) |
[Read the reference](https://researchpocket.github.io/docs/)

## Save your first link

Choose the browser app if you want to begin without installing anything. Choose
the CLI if you spend most of your time in a terminal. Both create a local
library, and you can add sync later.

### In a browser

1. Open [the ResearchPocket app](https://researchpocket.github.io/app/).
2. Choose **Create a local library**.
3. Paste a URL into the add field and press Enter. On a small screen, choose
   **Save a link**.
4. Open the saved item and add a title, note, or tag if that will help your
   future self.

Use the search box when you want the link again. Open a result to read its saved
context, change your note, or mark it as a favorite.

The library is stored in this browser profile. There is no ResearchPocket
account. Do not clear the site's browser storage unless the library is already
synced or you no longer need it.

If you already use ResearchPocket on another device, choose **Restore an
existing library** before adding anything on the new device.

### From the terminal

If Rust is installed, install the current CLI directly from crates.io:

```sh
cargo install --locked research
```

Alternatively, download the archive for your platform from the
[release page](https://github.com/ResearchPocket/researchpocket.github.io/releases),
check it against `SHA256SUMS`, and put `research` or `research.exe` somewhere on
your `PATH`.

Then create a library and save something:

```sh
research init
research add https://example.com/article
research list
research search example
```

The release archives are not code-signed or notarized. If your computer does not
accept one, install [Rust](https://www.rust-lang.org/tools/install) and build the
matching release tag from source instead of weakening system-wide security:

```sh
git clone --branch v2.0.1 --depth 1 \
  https://github.com/ResearchPocket/researchpocket.github.io.git
cd researchpocket.github.io
cargo build --locked --release
```

The binary is `target/release/research` on macOS and Linux, or
`target\release\research.exe` on Windows.

## Add context you will need later

A useful library is more than a list of URLs. A short note can preserve the
question you were asking when you found a source.

```sh
research add https://example.com/article \
  --title "Concurrency notes" \
  --tag thesis,rust \
  --note "Compare the failure model with chapter 3" \
  --favorite
```

Use the item ID shown by `research list` when you want to revise or recover it:

```sh
research edit "$ITEM_ID" --title "A clearer title" --add-tag reviewed
research delete "$ITEM_ID"
research restore "$ITEM_ID"
```

Saving the same URL twice creates two saves. ResearchPocket does not guess that
two visits had the same purpose.

For a keyboard-first view of the same library, run:

```sh
research tui
```

Press `?` inside the TUI for its shortcuts. `a` adds a link, `/` searches, `E`
fills missing metadata and can refresh a provider-owned excerpt, `Ctrl+E`
confirms replacement of any current excerpt, and `s` connects or runs private
sync.

## Save the page you are reading

The included bookmarklet sends the current page to the installed CLI. It does
not need a browser extension or a server running in the background.

1. Keep the CLI in a stable location and run `research init`.
2. Run `research capture install` and then `research capture status`.
3. Create a bookmark named `Save to ResearchPocket`.
4. Copy the single line from [bookmarklet.js](bookmarklet.js) into the bookmark's
   URL field.
5. Open a page and click the bookmarklet.

The bookmarklet can include the page title, description, language, and tags you
enter. Its tag prompt runs inside the open page, so use it only for non-sensitive
tags. Add private context later in ResearchPocket.

Browser captures are saved locally first. If you later turn on automatic
enrichment, ResearchPocket can fill metadata that the page did not provide. The
bookmarklet never carries a provider or credential. ResearchPocket skips the
extra request when all eligible metadata is already present.

See the [capture guide](docs/v2/CLI.md#browser-capture-through-the-url-scheme)
for browser and operating-system troubleshooting.

## Fill missing page details

Enrichment can fill a missing title, excerpt, or language after a link is safely
stored. It does not replace notes or other values you wrote yourself.

Use the built-in direct fetcher for public pages:

```sh
research add https://example.com/article --enrich direct
research enrich configure direct --on-capture
research enrich run
research enrich status
```

Firecrawl is available when a page needs a hosted extractor. Using it sends the
saved URL to the configured Firecrawl service. Its API key can come from the
environment or a separate local key file:

```sh
printf '%s' "$FIRECRAWL_API_KEY" | \
  research enrich configure firecrawl --api-key-stdin --on-capture
```

An offline or failed request leaves the save in place and keeps the job
retryable. The [enrichment reference](docs/v2/CLI.md#metadata-enrichment)
explains providers, retries, and replacement rules.

## Sync when you need another device

You do not need GitHub to use ResearchPocket. Sync exchanges updates and keeps
one private library current across your own browsers and computers.

Create an empty private GitHub repository and a fine-grained PAT that can access
only that repository with `Contents: read/write`. Give the token a short expiry.

For the native CLI and TUI, read it without showing it in the terminal:

```sh
printf 'Fine-grained GitHub token: ' >&2
IFS= read -r -s RESEARCHPOCKET_GITHUB_TOKEN
printf '\n' >&2
export RESEARCHPOCKET_GITHUB_TOKEN
research sync connect OWNER/PRIVATE_REPOSITORY
research sync run
unset RESEARCHPOCKET_GITHUB_TOKEN
```

Native ResearchPocket does not save the GitHub PAT. Set
`RESEARCHPOCKET_GITHUB_TOKEN` or `GH_TOKEN` before starting `research tui`, then
press `s` to connect or sync. The browser app keeps its token in memory by
default and can optionally remember it only for the current tab session.

On a new device, initialize an empty library and connect it before adding new
saves:

```sh
research --data-dir /path/to/new/library init
research --data-dir /path/to/new/library sync connect OWNER/PRIVATE_REPOSITORY
```

ResearchPocket exchanges immutable updates. It never asks you to merge, rebase,
or resolve Git conflicts in your library. Read the
[sync guide](docs/v2/CLI.md#private-github-synchronization) for setup and recovery
details.

## Know where your work lives

The CLI stores its library in the normal application-data directory:

- Linux: `${XDG_DATA_HOME:-~/.local/share}/researchpocket`
- macOS: `~/Library/Application Support/io.github.ResearchPocket.ResearchPocket`
- Windows: `%LOCALAPPDATA%\ResearchPocket\ResearchPocket\data`

Choose another directory with `--data-dir` or `RESEARCHPOCKET_DATA_DIR`:

```sh
research --data-dir /path/to/private/library init
```

`library.sqlite3` contains private working state. Do not commit or upload that
file, and do not copy it as a sync method. Use ResearchPocket sync when you need
the library on another device.

Deleting a save is recoverable. Secure erasure from a synced repository requires
rewriting its history or moving to a new repository. ResearchPocket stores links
and bounded excerpts; it is not a PDF, attachment, or full-page archive.

## Bring in an older library

The V1 importer reads the old database without changing it:

```sh
research --data-dir /path/to/new/library init
research --data-dir /path/to/new/library import v1 /path/to/old/research.sqlite
research --data-dir /path/to/new/library list --limit 20
```

Keep the old database and a backup until you have checked several saves. The
[migration guide](docs/v2/MIGRATION.md) lists what is preserved and how to verify
the result.

## Use it from scripts

Data commands support human, JSON, and NDJSON output:

```sh
research status --format json
research list --format ndjson --all > saves.ndjson
```

Machine data goes to standard output. Warnings and progress go to standard
error. Credentials and raw synchronization updates are not included.

## Read more

- [Complete CLI and TUI reference](docs/v2/CLI.md)
- [Hosted browser application](docs/v2/WEB.md)
- [Migration guide](docs/v2/MIGRATION.md)
- [Privacy threat model](docs/v2/THREAT_MODEL.md)
- [Synchronization protocol](docs/v2/SYNC_PROTOCOL.md)
- [Product contract](docs/v2/PRODUCT.md)
- [Contributing guide](CONTRIBUTING.md)

## Development

Use the pinned toolchain and locked dependencies:

```sh
cargo fmt --all -- --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace --all-targets --all-features
cargo audit --deny warnings
cargo build --locked --release
```

For the website and browser app:

```sh
cd web
npm ci
npm run verify
npm run dev
```

Tests focus on persistence, convergence, migration, privacy, and deployment
boundaries rather than framework details.
