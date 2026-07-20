# ADR 0002: Retryable link metadata enrichment after durable capture

- Status: accepted
- Date: 2026-07-18
- Issue: [#65](https://github.com/ResearchPocket/researchpocket.github.io/issues/65)
- Amended by: [ADR 0004](./ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md)

## Context

ResearchPocket already captures a URL and optional owner-supplied fields through
the CLI and the installed `researchpocket://` handler. That path is intentionally
offline-first: a slow page, broken network, or unavailable third party cannot be
allowed to lose the URL the owner chose to keep.

The existing V2 domain already converges nullable title, excerpt, and language
scalars. A browser has useful page metadata in its loaded DOM, while a native
client can sometimes retrieve better metadata from the public page or from an
explicitly selected extraction service. Full page bodies and files originally
remained outside this decision. ADR 0004 subsequently permits bounded cleaned
Firecrawl Markdown in the existing excerpt register; binary files and a general
object archive remain deferred.

## Decision

### Capture remains the durability boundary

The URL is committed before an optional network extractor runs. When enrichment
is requested, the create transaction also records a local-only durable job for
the same item. A provider timeout, offline state, invalid response, missing API
key, or process interruption therefore leaves a usable save and a retryable job.

Successful metadata is applied through one V2 mutation. The job records the
exact scalar revision that represented each missing field when it was queued;
apply requires both that same revision and a still-missing value. A human clear
therefore cannot be confused with untouched metadata. Enrichment revision IDs
use a reserved low-priority prefix, so an unsynchronized concurrent human
revision remains the visible scalar winner after convergence on existing V2
clients. An explicit empty string is also authored data, not a missing value.
Enrichment never changes the saved URL, note, tags, favorite state, saved time,
lifecycle, or a title/excerpt/language value written while a fetch was in
flight. The apply transaction also rejects a result when the URL or lifecycle
changed during the request, so metadata from an old page/state is retried rather
than attached to the current item.

Retry state is local SQLite projection data, not CRDT state or synchronization
protocol data. It stores provider, target-field revision preconditions, bounded
attempt state, timestamps, a sanitized error category, and a short-lived local
lease. A processor must claim that lease transactionally before contacting a
provider; another process cannot issue the same request unless the first process
has died and its lease expires. The job stores no response body, credential,
authorization header, or duplicate page content.

### The browser transport is append-only

Capture URI version 1 remains accepted. Version 2 adds bounded optional
`excerpt` and `language` singleton fields. The supplied bookmarklet reads the
current page URL, title, description metadata, and document language from the
already loaded DOM and sends no provider selection, credential, path, callback,
or repository coordinate. Those page-provided values can therefore be included
in the initial create without a second network request.

Old handlers continue rejecting unknown fields instead of silently
misinterpreting them. Owners update the bookmarklet only after installing a CLI
that accepts version 2.

### Providers are explicit and narrow

The direct provider fetches public HTML over HTTP(S) with no cookies,
credentials, referrer, or browser state. Every redirect is validated and DNS is
resolved and pinned for that hop. Loopback, private, link-local, multicast,
reserved, documentation, and cloud-metadata destinations are rejected. The
client also bounds redirects, connection and response time, content type, and
decoded response size. It extracts and normalizes only title, description, and
language.

Firecrawl is an explicit alternative, never an automatic fallback. ResearchPocket
calls the small Firecrawl `/v2/scrape` REST surface through its existing HTTP
client; it does not add the Firecrawl Cargo SDK. The owner must deliberately
configure Firecrawl and is told that the saved URL is sent to that third party.
The request disables Firecrawl cache storage, requires target TLS validation,
uses the predictable basic proxy tier, and bounds the response. ADR 0004
supersedes the original discard behavior: bounded cleaned Markdown is retained
as the missing excerpt while metadata continues to supply title and language.

The Firecrawl key may come from the current process environment or a separate
per-library credential file written from standard input. The file is created
with owner-only mode on Unix; on Windows it inherits the selected data
directory's access controls, so a custom data directory must be owner-restricted.
The non-secret provider configuration and the credential are not placed in
SQLite, the capture URI, handler manifest, CRDT updates, sync repositories,
command output, logs, or publication artifacts. Disabling enrichment removes the
local stored key.

## Alternatives considered

### Fetch before any local write

Rejected. It most closely resembles a synchronous scraper, but a timeout,
offline capture, browser-launched process interruption, or third-party outage
could discard the URL or invite duplicate retries by the owner.

### Put fetched metadata and retry state in a new domain schema

Rejected for this slice. Title, excerpt, and language already have native and
WASM convergence semantics. Provider attempts and error categories are local
operational state and do not justify making existing private repositories
incompatible with a new genesis schema.

### Use the Firecrawl Rust SDK

Rejected. ResearchPocket needs one authenticated endpoint and already has an
HTTP client. The SDK would add a second abstraction and more features than this
human-directed metadata flow uses.

### Store page HTML, PDFs, or attachments with the item

Deferred. Binary and raw-page retention needs a separately negotiated,
content-addressed object protocol with hashes, quotas, immutable remote paths,
orphan and garbage-collection rules, lazy restoration, integrity checks, and
publication exclusions. Binary objects and raw page bodies must not be embedded
in Loro updates or the SQLite projection.

## Consequences

- Ordinary capture stays useful offline and keeps its existing atomic
  item/projection/outbox guarantee.
- Browser DOM metadata usually avoids a network enrichment mutation.
- Network enrichment can add one later immutable update and is safe to retry;
  transactional leases prevent duplicate requests by concurrent local CLIs.
- Human-authored values remain canonical, including deliberate empty strings.
- Firecrawl use has an explicit privacy and credit boundary instead of becoming
  a hidden fallback.
- JavaScript-rendered or authenticated pages may still lack metadata unless the
  owner explicitly uses a capable provider; ResearchPocket does not automate
  login or browser interaction in this slice.
- Page archives and files remain a separate product and protocol decision.
