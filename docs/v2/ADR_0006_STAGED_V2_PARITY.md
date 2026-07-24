# ADR 0006: Stabilize the implemented V2 foundation before full parity

- Status: accepted
- Date: 2026-07-24
- Issue: [#107](https://github.com/ResearchPocket/researchpocket.github.io/issues/107)

## Context

Four `2.0.0-preview` releases exercised the native CLI and TUI, browser capture,
optional enrichment, immutable-update GitHub synchronization, and the hosted
owner application. The repository also defines a broader V2 target: local
loopback web serving, collections, selective publication, additional import and
export formats, consolidation governance, and repository profiles.

Those remaining surfaces are not implemented to their accepted privacy and
compatibility gates. Calling them present would be inaccurate; shipping partial
publication or repository switching would be unsafe. Keeping every implemented
and reviewed surface indefinitely labeled preview also obscures that the
current foundation has a stable protocol and supported upgrade path.

The old crates.io workflow creates a second ambiguity. The root binary depends
on `research-domain` and `research-store` as path-only internal crates. Both are
version `0.0.0` and deliberately have `publish = false`, so `cargo publish`
cannot package the root crate. Publishing the internal protocol/store crates
solely to make the binary installable requires a separate compatibility,
ownership, and release-order decision.

## Decision

Release `2.0.0` as the stable version of the implemented foundation:

- local URL capture, authored metadata, notes, tags, favorites, search,
  recoverable delete/restore, and machine-readable CLI output;
- keyboard-first TUI management;
- installed browser capture through the validated versioned URI;
- explicit direct or Firecrawl enrichment with durable retry jobs and human
  revision preconditions;
- private GitHub synchronization through immutable CRDT envelopes and bounded
  operation packs; and
- the offline-capable hosted owner application with IndexedDB outbox and
  memory-only/session-only GitHub credential handling.

Schedule the unfinished parity surfaces for the `2.1` iteration. Version 2.0
release notes and documentation must enumerate them and must not present them
as shipped. Existing privacy, convergence, protocol, and publication contracts
remain binding when those surfaces are implemented.

GitHub release archives and tagged source are the supported 2.0 distribution
channels. Remove the non-functional crates.io workflow. A future crates.io
release requires an explicit workspace-publication design; it must not silently
publish internal crates or substitute registry versions for reviewed path
dependencies.

The binary release workflow continues to stage every tag as a draft. Tags
containing a prerelease suffix are marked prerelease; stable tags are not.
Maintainers inspect artifacts and checksums before publishing a stable draft as
latest.

## Consequences

- `2.0.0` communicates stability for the surfaces users have already tested
  through the preview series.
- The broader V2 product direction remains visible and scheduled rather than
  being silently removed.
- Users who need local loopback serving, collections, selective publication,
  broader import/export, or repository profiles must wait for a later release.
- The `research` crate on crates.io remains on its historical version; 2.0
  installation instructions point only to verified GitHub assets or tagged
  source.
- No protocol version, CRDT schema, SQLite schema, or immutable update bytes
  change solely because of the stable version label.

## Verification

- Confirm CLI, web package, lockfile, tag, notes, and archive names agree on
  `2.0.0`.
- Verify the stable tag creates a non-prerelease draft while preview tags still
  create prerelease drafts.
- Run the complete Rust and web checks for the exact release commit.
- Inspect all four platform archives and `SHA256SUMS` before publication.
- Confirm release documentation lists every deferred product surface and does
  not recommend crates.io for 2.0 installation.
