# ResearchPocket V2 CLI

Status: command and output contract

The shipped CLI is the V2 surface:

```text
research init
research add <URL>
research enrich configure <direct|firecrawl>
research enrich status
research enrich run [<ITEM_ID>]
research enrich disable
research capture install
research capture status
research capture uninstall
research edit <ITEM_ID>
research delete <ITEM_ID>
research restore <ITEM_ID>
research import v1 <SOURCE_DB>
research list
research search <QUERY>
research tui
research sync connect <OWNER/NAME>
research sync run
research status
```

Private GitHub synchronization, optional foreground periodic sync, and GitHub
Pages owner editing are implemented. Background-service installation and V2
publication are not implemented in this slice. Git is never used to resolve
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
or copied as a synchronization mechanism. Synchronization exchanges immutable
CRDT update envelopes instead of SQLite files.

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
research add https://example.com/article --enrich direct
```

Only the URL is required. Without `--enrich`, capture is immediate and makes no
network request. Title, excerpt, language, note, favorite state, tags, and an
optional original `--saved-at <UNIX_SECONDS>` value are stored exactly as
supplied. Saving the same URL twice creates two distinct items.

`--enrich direct|firecrawl` still commits the item first. The create transaction
also writes a local retry job. When at least one eligible metadata field is
missing, the CLI then attempts the network request; a fully populated item is
marked skipped without contacting the provider. If a request fails, `research
add` remains successful, prints a sanitized warning to stderr, and leaves the
job queued instead of inviting a duplicate save.

## Metadata enrichment

Enrichment can fill a missing title, excerpt, or language after the URL is
durable. It never changes the URL, note, tags, favorite state, saved time, or
lifecycle state. A field is eligible only when the exact missing-field revision
recorded at queue time is still current when the result is applied. A later
human clear/edit and a concurrent unsynchronized human revision both win.
`--title ""`, `--excerpt ""`, and `--language ""` are authored values and are
not replaced.

### Direct public-HTML provider

Use it for one item without changing configuration:

```sh
research add https://example.com/article --enrich direct
research enrich run "$ITEM_ID" --provider direct
```

Or make it the provider for browser captures:

```sh
research enrich configure direct --on-capture
research enrich status
```

The direct provider sends an unauthenticated HTTP(S) request from the local
device. It sends no cookie, authorization header, referrer, or browser state;
validates every redirect and resolved address; rejects private and special-use
destinations; and bounds redirects, time, content type, and response size. It
parses only public HTML metadata.

### Firecrawl REST provider

Firecrawl is never an automatic fallback. Selecting it means the saved target
URL is sent to the configured Firecrawl service. ResearchPocket uses the narrow
`/v2/scrape` REST endpoint through its existing HTTP client. It retains cleaned
Markdown in a missing excerpt, plus normalized title and language metadata, and
adds no Firecrawl Cargo dependency. Markdown is preserved up to 4 MiB inside the
existing convergent excerpt register; the complete JSON response is limited to
8 MiB. Larger results fail explicitly and remain retryable without affecting the
already-saved URL. The request includes the complete page instead of restricting
extraction to main content, disables Firecrawl cache storage, requires target TLS
validation, and uses the basic proxy tier.

Passing an item ID and `--provider firecrawl` can upgrade an excerpt created by
an earlier enrichment run. The replacement is allowed only while the current
winning excerpt revision is enrichment-owned; authored excerpts and explicit
clears remain ineligible.

To deliberately re-parse a saved URL and replace any current excerpt, including
authored content, use the explicit replacement flag:

```sh
research enrich run <item-id> --provider firecrawl --replace-excerpt
```

The job records the exact current excerpt revision before network access. If the
excerpt changes while Firecrawl is running, the fetched Markdown is skipped and
the newer local or synchronized value wins.

Store the key in a separate per-library file without placing it in process
arguments or shell history:

```sh
printf '%s' "$FIRECRAWL_API_KEY" | \
  research enrich configure firecrawl --api-key-stdin --on-capture
research enrich status
```

Alternatively, set `FIRECRAWL_API_KEY` only for a command. An explicitly
configured self-hosted API origin may be selected with `--api-url <URL>`. The
non-secret configuration and optional key file remain outside SQLite, CRDT
updates, sync repositories, handler manifests, and command output. Status shows
only whether a credential is available and its source, together with aggregate
pending/retry/in-progress/completed/failed/skipped job counts.

The key file is created with owner-only mode on Unix. On Windows it inherits the
selected data directory's access controls; owners who use a custom data directory
must keep that directory restricted to their account.

### Queue and retries

```sh
# Process due jobs, up to 25 by default.
research enrich run

# Process or queue one item immediately.
research enrich run "$ITEM_ID"

# Inspect configuration without exposing a key.
research enrich status --format json

# Remove configuration and any locally stored Firecrawl key.
research enrich disable
```

Jobs are local operational state. A short-lived transactional lease ensures two
local CLI processes cannot contact the provider for the same job concurrently;
an abandoned lease becomes retryable after it expires. Provider failures use
bounded retries and a sanitized category; page bodies and credentials are never
stored in a job. Successful bounded Firecrawl Markdown is stored only through
the normal excerpt mutation, not duplicated in the job. A successful result is
one V2 edit/outbox update only when at least one eligible field is applied. Raw
HTML, PDF, and attachment storage remains outside this feature; see
[ADR 0002](./ADR_0002_LINK_ENRICHMENT.md) and
[ADR 0004](./ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md).

## Browser capture through the URL scheme

The installed CLI registers a per-user `researchpocket://` URL-scheme handler
with the operating system. The handler is browser-independent: a browser,
bookmarklet, or other local integration can dispatch a valid capture URI. It
invokes the same V2 store mutation as `research add`; there is no background
server, required browser extension, Pocket provider, raw SQLite handoff, or
network dependency.

### Install the native handler

First put the binary at its long-term location and initialize the library that
browser captures should use. Then install and inspect the handler:

```sh
research init
research capture install
research capture status
```

Installation is idempotent. It registers `researchpocket://` only for the current
operating-system user and binds the current executable plus the resolved absolute
V2 data directory. It does not require administrator privileges. The platforms
use their normal per-user facilities:

- Linux installs an XDG desktop protocol association and uses `xdg-mime`;
- macOS installs a per-user application bridge that receives the URL event; and
- Windows installs a per-user URL-protocol registry association.

A browser-launched process does not reliably inherit variables from an open
terminal. If this library uses an override, provide it while installing:

```sh
research --data-dir /absolute/path/to/private/library capture install
```

`RESEARCHPOCKET_DATA_DIR` follows the usual global precedence and is resolved at
installation time. Neither selection method puts a database path in a capture
URI. Re-run `capture install` after moving the executable or switching the target
library. On macOS, the application bridge contains a private copy of the CLI, so
re-run installation after every CLI upgrade as well.

### Add and use the browser bookmarklet

1. Create a bookmark in a browser that permits JavaScript bookmark URLs. In
   Firefox, show the Bookmarks Toolbar, right-click it, and choose
   **Add Bookmark**.
2. Set the name to `Save to ResearchPocket`.
3. Copy the entire one-line [bookmarklet.js](../../bookmarklet.js) into the
   bookmark's **URL** or **Location** field. It must begin immediately with
   `javascript:`.
4. Visit an HTTP(S) page and click the bookmarklet. Enter optional
   comma-separated tags, leave the prompt blank for an untagged save, or choose
   **Cancel** to abort the capture.
5. When the browser asks about opening an external application, choose
   ResearchPocket and allow the link to open. Remembering the choice is optional
   and may be scoped to the current site or browser profile.
6. Run `research list` to confirm the local capture.

The supplied bookmarklet sends version 2 plus the current page `url`, `title`,
bounded description metadata as `excerpt`, and the document `language`, all read
from the already-loaded DOM. Each nonblank prompted tag is whitespace-normalized,
deduplicated, and appended as one `tag` field. The prompt accepts at most 64 tags
of at most 1,024 UTF-8 bytes each; tags cannot contain a comma in this compact
input format. It does not contain a token, repository name, filesystem path,
provider name, note, or favorite value. Browsers may ask again in private
browsing or when site permissions are cleared. Do not disable external-protocol
safety checks globally. In Firefox, the handler appears under
**Settings → General → Applications** as the `researchpocket` action.

Bookmarklet code and its prompt run in the current page's untrusted JavaScript
context. The open page may observe text entered there. Use the prompt only for
non-sensitive organizational tags; add private or sensitive tags after the local
save through `research edit`, `research tui`, or the owner app.

### Capture URI contract

The version 2 transport used by the supplied bookmarklet has this shape:

```text
researchpocket://capture?version=2&url=<percent-encoded-http(s)-url>&title=<percent-encoded-title>&excerpt=<percent-encoded-description>&language=<percent-encoded-language>&tag=<percent-encoded-tag>&tag=<percent-encoded-tag>
```

Version 1 remains accepted with URL/title and the existing advanced authored
fields. Version 2 adds optional singleton `excerpt` and `language` fields. In
both versions, one absolute HTTP(S) `url` is required; `title` is optional. The
standard bookmarklet and advanced local integrations may repeat `tag`; advanced
integrations may also provide one `note` and one `favorite=true` field:

```text
researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&title=Example&tag=read&tag=rust&note=Review&favorite=true
```

The advanced/internal entry point is available for protocol dispatch and manual
diagnosis:

```sh
research capture handle \
  'researchpocket://capture?version=1&url=https%3A%2F%2Fexample.com&title=Example'
```

Only the exact `researchpocket://capture` route is accepted. Unsupported
versions, non-HTTP(S) targets, fragments, user information, or ports on the outer
custom-scheme URI, unknown fields, repeated singleton fields, invalid booleans,
and oversized payloads fail before the library changes. An ordinary target page
URL may still contain its own port or fragment. Repeated `tag` is the sole
intentional repeated field. The URI never accepts a data or database path,
provider, GitHub coordinate or credential, executable argument, or shell
fragment.
Percent-decoded values are passed as data rather than evaluated by a shell.

One accepted URI creates exactly one item through the normal atomic V2 path. Its
CRDT state, SQLite projection, immutable update, durable outbox, and device
sequence commit together. When local `--on-capture` configuration is enabled,
the same transaction also records a local-only enrichment job; the URI cannot
choose that provider. Network work starts only after commit, and its failure
cannot roll the save back. A desktop-notification failure likewise cannot roll
back the durable save.

### Sync, removal, and troubleshooting

Browser capture is deliberately local. It never starts synchronization or reads
a GitHub token. Optional locally configured enrichment may contact the captured
public URL or explicitly selected Firecrawl service only after the save commits.
Upload queued captures separately:

```sh
research sync run
# Or, while foreground polling is useful:
research sync run --every 60
```

Inspect or remove the current user's association with:

```sh
research capture status
research capture uninstall
```

Uninstalling does not delete the V2 library, its outbox, or browser bookmarks.
For a failed launch or a capture that appears to be missing:

1. run `research capture status` and verify the registered executable and bound
   data directory;
2. rerun `research capture install` from the binary's current stable location;
3. when using an override, run `research --data-dir <DIR> list` against the same
   directory shown by capture status;
4. check the browser's external-protocol or application settings, then trigger
   the bookmarklet again; in Firefox, inspect **Settings → General →
   Applications** for the `researchpocket` action; and
5. on Linux, verify that `xdg-mime` is installed and available.

The custom protocol is an append-only integration surface. A site for which the
owner remembers external-protocol permission may attempt unwanted captures. URI
validation limits that risk to bounded save spam: the transport cannot read or
edit the library, execute commands, select a database, obtain credentials, or
start sync. See [THREAT_MODEL.md](./THREAT_MODEL.md#native-bookmarklet-capture).
The custom-handler tradeoff is recorded in
[ADR 0001](./ADR_0001_NATIVE_BROWSER_CAPTURE.md); the post-save enrichment
boundary is recorded in [ADR 0002](./ADR_0002_LINK_ENRICHMENT.md).

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

## Terminal interface

```sh
research tui
```

The TUI requires an interactive terminal and uses the resolved V2 data directory.
It does not support JSON/NDJSON output, make network requests, read GitHub
credentials, or start synchronization. Its footer reports active/deleted counts,
the pending outbox count, and sanitized synchronization state.

Main view shortcuts:

| Key | Action |
| --- | --- |
| `j`/`k`, arrows | Move selection |
| `g`/`G`, Home/End | First/last save |
| `Ctrl+U`/`Ctrl+D` | Scroll long item details |
| `a` | Capture a URL |
| `e` or Enter | Edit the selected save |
| `/` | Search URL, title, excerpt, private note, and tags through SQLite FTS |
| Space | Toggle favorite |
| `x` | Confirm recoverable deletion |
| `r` | Restore a deleted save |
| `f` | Toggle favorite-only results |
| `d` | Cycle active, all, and deleted lifecycle views |
| `R` | Refresh local state |
| `?` | Open keyboard help |
| `q` in the main view or `Ctrl+C` anywhere | Exit and restore the terminal |

Capture and edit forms use Tab/Shift+Tab to move through URL, title, excerpt,
private note, exact tags, and favorite state. `Ctrl+N` inserts a note newline,
`Ctrl+S` commits, and Escape cancels. Pasting multiline text into the note field
preserves newlines; other fields normalize pasted newlines to spaces.
The tags field accepts a convenient comma-separated list for ordinary tags or a
JSON string array for exact commas and leading/trailing whitespace. Existing
tags open as JSON, so saving an untouched field is lossless.
Search accepts the same SQLite FTS5 syntax as `research search`, including quoted
phrases and `*` prefix queries; malformed syntax is reported without changing the
active result set.

If another local or synchronized writer changes a note after its edit form opens,
the TUI refuses the stale whole-note replacement and asks the owner to reopen the
item. This prevents an old form buffer from erasing newer character-level note
updates.

Stored control characters are rendered as inert replacement glyphs, so imported
or synchronized content cannot emit terminal escape sequences. The underlying
authored value remains unchanged.

Every successful authored action calls the existing `V2Store` API. It therefore
has the same atomic CRDT snapshot, projection, immutable batch, outbox, validation,
and error behavior as the corresponding CLI action. The TUI does not duplicate
domain or synchronization rules.

## Private GitHub synchronization

Create an empty private GitHub repository first. Give a fine-grained PAT with an
expiry of at most 90 days access to only that repository with
`Contents: read/write`, then read it silently in Bash or Zsh, export it only
while the sync commands run, and remove it from the shell afterward:

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

`GH_TOKEN` is accepted as a fallback. ResearchPocket uses the token only in a
sensitive HTTP authorization header. It never writes the token to SQLite, sync
updates, URLs, logs, generated files, or command output. The repository must
already exist, be private, expose a default branch name, and not be archived or
disabled. ResearchPocket bootstraps the default branch of an empty repository;
`--branch <NAME>` selects an existing non-default branch.

On the first device, `sync connect` creates immutable
`sync/v1/library.json`, pulls any compatible updates, uploads the exact durable
outbox batches, and pulls once more. Repository commits are transport audit
records only. The CLI never runs merge, rebase, or force-push and never uploads
`library.sqlite3`.

To restore on another device, initialize a completely separate empty data
directory and connect it to the same repository:

```sh
research --data-dir /path/to/second-device init
research --data-dir /path/to/second-device sync connect OWNER/PRIVATE_REPOSITORY
research --data-dir /path/to/second-device list
```

Only a pristine local library may adopt the remote library identity. Its own
device identity remains unique. A nonempty library with another identity fails
closed instead of combining unrelated saves.

Run a normal cycle explicitly or keep a foreground process polling while it is
needed:

```sh
research sync run
research sync run --every 60
research --format ndjson sync run --every 60
```

The periodic interval is 15 seconds to 24 hours. Periodic JSON requires NDJSON
because it emits a stream. Network, server, contention, and rate-limit failures
remain recorded, keep every exact outbox byte, and retry in the foreground;
authentication, version, integrity, and configuration failures stop for owner
action. A one-shot failure also leaves the outbox untouched for the next
`research sync run`.

The repository layout, immutable identity rules, retries, and convergence
contract are defined in [SYNC_PROTOCOL.md](./SYNC_PROTOCOL.md). Credential and
repository boundaries are defined in [THREAT_MODEL.md](./THREAT_MODEL.md).

## Status

```sh
research status
```

Status is safe before initialization and reports `initialized: false`. For an
initialized library it shows library and device identities, active and deleted
item counts, import summaries, pending outbox and causally deferred update
counts, synchronization state, configured repository/branch, and the last
successful sync or sanitized error category. It never exposes a credential or
update payload.

## Output contract

Human output and machine data go to stdout. Progress, warnings, and import
diagnostics go to stderr. Machine timestamps use RFC 3339 UTC. A top-level
`schema_version` versions CLI output independently of library and synchronization
protocol versions.

Create, edit, delete, and restore JSON output use the same materialized item
shape as list entries, plus top-level `schema_version` and `command` fields. They
do not expose causal revisions, CRDT bytes, or transport payloads.

Enrichment configuration/status JSON reports the selected provider,
capture-default flag, API origin, credential availability/source, and aggregate
queue counts; it never contains the credential. Enrichment-run JSON reports
aggregate outcomes plus item ID, provider, job status, attempt count, applied
field names, sanitized error category, and next retry time for each attempted
job. It never emits fetched candidates or raw response content.

Sync JSON includes only repository identity, aggregate pull/apply/upload counts,
whether a pristine device adopted the remote library, and the remaining pending
count. Periodic NDJSON emits one `sync_run` record per successful cycle and a
sanitized `sync_error` record for retryable failures.

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
