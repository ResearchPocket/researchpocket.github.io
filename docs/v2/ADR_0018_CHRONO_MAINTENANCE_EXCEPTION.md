# ADR 0018: Temporary chrono maintenance exception

- Status: accepted
- Date: 2026-11-19
- Issue: [#227](https://github.com/ResearchPocket/researchpocket.github.io/issues/227)
- Removal: [#228](https://github.com/ResearchPocket/researchpocket.github.io/issues/228)

## Context

The required dependency audit blocks deployment of the offline owner fix (#225)
on three patchable findings and RUSTSEC-2026-0543. The latter marks all chrono
versions unmaintained; it does not describe an exploitable defect or provide a
patched release. Chrono participates in native and WASM RFC3339 validation,
protocol timestamps, imports, checkpoint/genesis validation, and local leases.
A rushed replacement would mix compatibility-sensitive domain changes into a
static-shell repair.

## Decision

Upgrade SQLx/SQLite, quinn-udp, and rustix to patched compatible versions.
Add only RUSTSEC-2026-0543 to the existing advisory exception list, explicitly
linked to #228. Keep `cargo audit --deny warnings` and required branch checks.
Do not suppress the patchable findings or any future chrono advisory.

Retain chrono's current version and timestamp behavior for this deployment.
Issue #228 must select a maintained implementation, verify identical native/WASM
behavior against the released protocol, and remove this exception when chrono
leaves the dependency graph. Any incompatible timestamp behavior requires its
own versioned compatibility decision before implementation.

## Consequences and recovery

The release accepts the maintenance risk of chrono temporarily. Existing
validation and serialized timestamps remain unchanged; no schema migration,
remote rewrite, or user recovery action is required. This does not establish a
general exemption for unmaintained packages. Reverting the exception blocks the
current audit until #228 is complete; security updates to other dependencies
can be rolled forward independently.

The source advisory is [RUSTSEC-2026-0543](https://rustsec.org/advisories/RUSTSEC-2026-0543).
