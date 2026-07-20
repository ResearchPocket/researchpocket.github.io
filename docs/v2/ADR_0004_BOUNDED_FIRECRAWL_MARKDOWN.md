# ADR 0004: Retain bounded Firecrawl Markdown in the excerpt register

- Status: accepted
- Date: 2026-07-20
- Issue: [#79](https://github.com/ResearchPocket/researchpocket.github.io/issues/79)
- Amends: [ADR 0002](./ADR_0002_LINK_ENRICHMENT.md)

## Context

Firecrawl already returns cleaned Markdown from the explicitly selected
`/v2/scrape` request, but ADR 0002 originally discarded it after reading title,
description, and language metadata. The owner requires useful page content to
remain available offline and accepts that this private content will converge and
remain in immutable synchronization history.

The existing nullable excerpt scalar already has native and WASM convergence,
missing-revision preconditions, search projection, export behavior, and owner UI
support. Introducing a second content field or a new object protocol would add a
compatibility boundary before the product needs binary or independently streamed
objects.

## Decision

An explicitly selected Firecrawl enrichment requests the complete page rather
than main-content-only extraction and stores the returned cleaned Markdown in
the existing excerpt register when that field is still missing at apply time.
Direct enrichment remains metadata-only. Authored excerpts, explicit clears,
concurrent edits, lifecycle changes, and URL changes continue to win under the
ADR 0002 preconditions.

An explicit re-enrichment may replace the currently visible excerpt only when
its winning revision is owned by the low-priority enrichment namespace. This
lets items enriched before this ADR upgrade their former metadata description
to page Markdown without treating authored content as replaceable.

The CLI additionally exposes an explicit `--replace-excerpt` re-parse action.
It may target any current excerpt, but records that exact winning revision before
network access and applies the replacement only if the revision is unchanged.
This is a deliberate visible-field replacement, not background enrichment.

Markdown whitespace is preserved after CRLF normalization and removal of control
characters other than newline and tab. Retained Markdown is limited to 4 MiB of
UTF-8, and the complete Firecrawl JSON response is limited to 8 MiB. Content over
either limit produces the existing sanitized `response_too_large` failure; the
URL remains saved and the local job remains retryable. Oversized content is never
silently truncated.

The 4 MiB content limit keeps one Base64 envelope and its nested operation-pack
representation below the existing 20 MiB pack ceiling. Pack construction still
splits queued envelopes according to the existing exact-byte budget. Markdown is
not copied into enrichment job state: after a successful request it enters the
library only through the normal atomic excerpt mutation and outbox update.

The owner Reader renders retained Markdown through `react-markdown` with GFM
extensions. Raw HTML remains disabled, scripts cannot execute, and Markdown
images become inert text placeholders rather than third-party network requests.
Publication remains allowlisted and must treat enriched excerpts exactly like
any other private excerpt; no excerpt becomes public without explicit collection
and field policy.

## Consequences

- A private library, checkpoint, restore, export, and sync history may be much
  larger than a URL-and-metadata-only library.
- Re-enrichment can replace a prior enrichment-owned excerpt, but it cannot
  overwrite an authored excerpt or explicit clear unless the owner invokes the
  explicit replacement action.
- Git history retains the Markdown after item deletion; secure erasure still
  requires the documented history rewrite or a new data repository.
- Search can match preserved page text through the existing excerpt projection.
- Raw HTML, PDFs, screenshots, attachments, scheduled refreshes, and a general
  archival object store remain deferred.

## Verification

- Parse a representative Firecrawl response and preserve Markdown newlines,
  indentation, and formatting markers exactly after newline normalization.
- Reject Markdown over the 4 MiB bound without producing a candidate.
- Preserve ADR 0002's authored-field and concurrent-revision tests.
- Run native/WASM convergence, sync, web, and production artifact checks.
