# ADR 0001: Native browser capture through a custom URL scheme

- Status: accepted
- Date: 2026-07-13
- Issue: [#6](https://github.com/ResearchPocket/ResearchPocket/issues/6)

## Context

The V2 CLI can save an HTTP(S) URL locally and atomically through
`research add`, but a Firefox bookmarklet cannot execute an installed binary.
ResearchPocket needs a fast offline bridge that does not require an
internet-facing backend, a continuously running local service, or a Pocket-era
database path.

The old `research://save` implementation is not a V2 integration. It selected a
raw SQLite file from the URI, carried a provider name, fetched metadata before
saving, and wrote through retired V1 modules. Its macOS bundle also expected a
custom URL as a command-line argument even though Launch Services delivers it as
an application URL event.

## Decision

ResearchPocket uses a new, versioned `researchpocket://capture` URL scheme as an
invocation transport from a user-installed Firefox bookmarklet to the installed
V2 CLI.

`research capture install` validates an existing V2 library and registers a
handler only for the current operating-system user. Installation binds the
resolved absolute library directory locally. The capture URI cannot select a
database, executable, provider, repository, credential, or synchronization
operation.

The handler accepts one bounded URI with the exact route and protocol version.
It requires one absolute HTTP(S) target URL, accepts only the documented authored
capture fields, rejects duplicate singleton and unknown fields, and treats every
decoded value as inert data. An accepted request calls the same
`V2Store::create_item` transaction as `research add`, producing one local item
and one durable immutable outbox update without a network request.

Platform registration follows each operating system's per-user mechanism:

- Linux uses an owned XDG desktop entry and the
  `x-scheme-handler/researchpocket` association;
- Windows uses the current user's `Software\\Classes\\researchpocket` registry
  key; and
- macOS uses an owned application bundle whose native AppKit delegate receives
  the Launch Services URL event and dispatches one argument to the bundled CLI.

Registration never invokes authored URI content through a shell. A generic
desktop notification is best-effort and happens only after the local mutation
commits. Capture does not run synchronization; the normal `research sync run`
workflow drains the outbox later.

## Alternatives considered

### Reuse `research://save`

Rejected. The scheme can still be associated with an installed V1 handler, and
its provider/database-path contract violates the V2 storage and privacy model.

### Persistent loopback HTTP service

Rejected for bookmarklet capture. It requires another process to be running,
introduces origin/authentication and port-discovery concerns, and makes offline
capture less predictable. A future local UI API remains a separate product
surface.

### Firefox extension with native messaging

Deferred. Native messaging provides a stronger browser-specific integration but
requires maintaining and installing both an extension and a native-host manifest.
The custom scheme keeps V2 capture available from one installed CLI and one
ordinary bookmark.

### Send the page to the hosted owner application

Rejected as the native CLI path. It would write to a separate browser replica,
depend on that origin's storage lifecycle, and would not satisfy the request to
capture through the installed local library.

## Consequences

- Capture works offline and needs no running server or browser extension.
- One OS-user scheme association points at one bound V2 library at a time.
  Reinstalling intentionally switches that library.
- Moving or replacing a handler binary may require `research capture install`
  again; `research capture status` exposes the bound paths.
- Custom schemes do not authenticate their caller. Firefox's external-protocol
  prompt is useful but is not the security boundary because a user can remember
  the choice. Strict validation and an append-only action reduce abuse to bounded
  unwanted saves; the handler cannot read, edit, delete, publish, or synchronize.
- The captured page URL and title pass through Firefox, OS dispatch, and process
  arguments. The standard bookmarklet therefore includes no note, tags, path,
  repository identity, or credential.
- Custom scheme ownership is not globally exclusive. Another application can
  replace the association; status and reinstall are the recovery path.

The detailed command and URI contract is in [CLI.md](./CLI.md), and the threat
boundary is maintained in [THREAT_MODEL.md](./THREAT_MODEL.md).
