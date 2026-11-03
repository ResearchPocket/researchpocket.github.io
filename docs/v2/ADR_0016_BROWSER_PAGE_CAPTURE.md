# ADR 0016: Firecrawl page capture in the owner app

- Status: accepted
- Date: 2026-11-03
- Amends: [ADR 0004](./ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md) (a second
  producer of captured documents); [ADR 0015](./ADR_0015_BYOK_AI_ASSISTANCE.md)
  (the reviewed owner-app destinations); THREAT_MODEL.md (TM-14); WEB.md;
  AGENTS.md.

## Context

The native CLI captures a page as bounded, content-addressed Firecrawl
Markdown (ADR 0004) and, since #215, does so for every browser capture by
default. The hosted owner app, which is how owners save from a phone or a
computer without the CLI, could only read captured pages. A save made there
kept just its URL, title, and excerpt, and the assistant (ADR 0015) had no page
body to work from.

Three facts make browser capture possible without a backend:

- Firecrawl answers CORS preflights from any origin with
  `access-control-allow-origin: *` and allows the `Authorization` header, so
  the owner app can call `/v2/scrape` directly. `GET /v2/team/credit-usage`
  confirms a key without spending a credit.
- The WASM domain core already exports `createCapturedDocument`, the native
  normalization, size bound, and hashing.
- The CRDT already holds a captured-document register; the CLI writes it.

## Decision

### One surface per concern

- **Key and policy:** *Settings → Assistant → Page capture* holds the Firecrawl
  key and one choice, **Capture each new save** (on by default, matching the
  CLI). It works with or without a model provider. The key follows the
  assistant key's lifecycle: tab memory by default, remembered only with the
  owner's consent in the profile's local-only credential database, under its
  own `firecrawl` record. It never enters the library replica, outbox, sync,
  exports, logs, or caches.
- **Reading and editing: the excerpt is the body.** The excerpt is the save's
  one editable body and its source of truth. The Reader's edit (pencil) button
  turns the Reader itself into the editor: title, tags, excerpt, and note become
  fields in place, and the sticky toolbar offers **Save** and **Cancel**. The
  Edit save dialog remains for quick edits from the library list and command
  palette, without an excerpt field. A captured page is the read-only *original
  page*; its line (provider, capture date, size) and actions sit under the
  title, never at the end of a long page:
  - excerpt only: the excerpt, with **Capture page**;
  - original page only: the page, with **Recapture**; editing starts from the
    page, and a changed copy becomes the excerpt while the original stays;
  - both: the excerpt, with **Use captured page** (replaces the excerpt, with
    Undo) and **Recapture**;
  - neither: "Nothing saved from this page yet." with **Write excerpt** and
    **Capture page**.

  An excerpt left unchanged in the editor is not saved, so editing only the
  title never copies a page. In a tab without the key, the capture controls
  open settings instead.
- **Assistant:** unchanged. Its requests already include the captured page, so
  capturing improves suggested tags, summaries, and titles with no new control.

### The request matches the CLI

The owner app sends the same `/v2/scrape` body as `research enrich`: Markdown
only, the whole page, TLS verification on, the basic proxy, and Firecrawl's
cache disabled. Only the saved URL (without its fragment) and the key leave
the browser. The response is read with an 8 MiB bound; the Markdown becomes a
captured document only through the domain core's `createCapturedDocument`, so
normalization, the 4 MiB limit, and the hash are the native ones.

### Attaching is an ordinary edit

The browser `edit` mutation gains an optional `captured_document` reference. It
writes the same register the CLI writes, through `write_captured_document`,
which validates the reference first. The update carries only the hash, length,
media type, and provenance (`firecrawl`, source URL, capture time). It is an
explicit owner action, so it uses an ordinary revision ID rather than the
enrichment prefix that yields to concurrent human edits. The CLI's
`enrich forget` still drops a page.

### Page text enters the excerpt only when the owner asks

The excerpt is merged CRDT text: every character replicates to every device,
rides in every checkpoint, and stays in history V2 never prunes. Sixty saves
enriched before #192, which put whole pages in their excerpts, carry 5.7 MB
that way in one real library, the largest 1.5 MB. A captured page is a separate
file fetched only when it is shown.

So an unedited capture costs no merged text. Its text is copied into the excerpt
only when the owner edits it or chooses **Use captured page**, and then the
excerpt holds exactly what the owner decided to keep, usually a trimmed page.
The original stays immutable for later reference or a fresh copy; **Recapture**
replaces it, and Undo after a recapture points back at the version it replaced.

This changes no protocol, schema, or projection: native clients already apply
and display the register.

### Content travels before the update that references it

The Markdown is stored in the browser's `capturedDocuments` store, marked
pending, before the edit commits. Each sync cycle uploads pending pages after
pulling and before uploading any queued update, the order the CLI uses.
Uploads are create-only at `sync/v2/content/sha256/<aa>/<sha256>.md`. An
identical existing object is success; different bytes at the address stop sync
as an integrity failure without discarding local data. A page confirmed in the
repository, or downloaded from it, is never uploaded again. A library that is
not connected to sync keeps its captures locally and uploads them once
connected.

### The destination is reviewed

`https://api.firecrawl.dev` is listed under `captureOrigins` in
`web/src/assistant/providers.json`, beside the assistant origins. The owner
app's `connect-src` includes it, and `check:dist` requires the built policy to
match the registry exactly. A self-hosted Firecrawl origin is not reachable
from the owner app; owners who self-host keep using the CLI.

## Alternatives considered

- **A separate settings section or panel for page capture.** Rejected as
  redundant: keys for third-party services already live under *Assistant*.
- **A collapsible "Captured page" section under the excerpt.** Replaced: it
  presented one save as two texts without saying which one an edit changes.
- **Editable page versions.** Briefly shipped: **Edit page** wrote each edit as
  a new content-addressed page. Replaced because it gave a save two editable
  texts; edits now always go to the excerpt.
- **Copying every capture into the excerpt.** Rejected: unedited pages would
  become permanent merged text.
- **Tabs between the excerpt and the original page.** Considered; one
  **Use captured page** action with Undo was preferred as the smaller control.
- **Capturing implicitly before an assistant request.** Rejected: it would
  spend Firecrawl credits as a side effect of a different action.
- **A browser retry queue like the CLI's.** Deferred. A failed capture leaves
  the save unchanged with **Capture page** still offered; durable retries can
  follow if owners need them.
- **A new mutation type.** Rejected: the edit mutation already carries
  normalization, outbox summaries, and stale-state checks.

## Consequences

- Saves made in the owner app gain whole-page captures, readable offline and
  used by the assistant.
- The owner app can reach one more reviewed origin, and the threat model
  records it.
- Unreferenced content may be uploaded when a page is recaptured before sync;
  it is private, content-addressed, and harmless, like an overwritten capture
  from the CLI.
