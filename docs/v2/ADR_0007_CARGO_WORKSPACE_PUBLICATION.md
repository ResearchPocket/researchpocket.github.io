# ADR 0007: Publish the Cargo workspace in dependency order

- Status: accepted
- Date: 2026-07-24
- Issue: [#108](https://github.com/ResearchPocket/researchpocket.github.io/issues/108)
- Supersedes: the 2.0.0-only distribution decision in
  [ADR 0006](./ADR_0006_STAGED_V2_PARITY.md)

## Context

The historical `research` crate predates the V2 workspace. V2 separates the
shared CRDT/protocol implementation into `research-domain` and local
persistence into `research-store`. Both were private version `0.0.0` path
dependencies, so crates.io could not package or verify the root binary.

Publishing only the root crate would cause Cargo to remove its path
dependencies and resolve unrelated or missing registry packages. Publishing
placeholder internal crates would create the same risk while making an
accidental compatibility promise.

## Decision

Publish three Apache-2.0 crates from one exact protected-main tag:

1. `research-domain`;
2. `research-store`, with an exact-version dependency on `research-domain`; and
3. `research`, with exact-version dependencies on both internal crates.

All three use the product release version and move in lockstep. Local workspace
builds retain path dependencies, while published packages require that same
exact registry version. The internal crates are implementation packages, not
independently versioned product extension points.

The Cargo publication workflow is manual and may run only after the matching
GitHub release is public. It verifies that:

- the tag belongs to protected `main`;
- the tag, every package, and the public GitHub release use the same version;
- all packages can be assembled from the clean tagged tree;
- an existing registry version has the same crate checksum before it is treated
  as an idempotent success; and
- publication proceeds in dependency order with bounded retries for registry
  propagation.

After publication, the workflow installs the exact `research` version from
crates.io and confirms the binary version. A different checksum at an existing
name/version is an integrity failure.

## Consequences

- `cargo install --locked research` becomes a supported installation path from
  version 2.0.1 onward.
- The internal domain and store source is packaged publicly under the same
  license and tag as the binary.
- A release cannot publish only one workspace crate and still be considered
  complete.
- Future package changes must preserve lockstep versions or replace this ADR
  with a reviewed compatibility and release-order plan.
- Registry publication remains downstream of the verified GitHub release;
  crates.io is not the source of tag, release-note, or artifact truth.

## Verification

- Run `cargo package --locked` or `cargo publish --dry-run --locked` for each
  package at the point its exact dependencies are available.
- Verify packaged source excludes credentials, local databases, build output,
  and private protocol data.
- Publish through the pinned workflow and confirm remote checksums.
- Install the exact registry version into an empty Cargo root and confirm
  `research --version`.
