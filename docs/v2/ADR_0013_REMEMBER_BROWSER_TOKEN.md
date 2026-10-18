# ADR 0013: Opt-in persistent browser GitHub tokens

- Status: accepted
- Date: 2026-10-18
- Issue: [#190](https://github.com/ResearchPocket/researchpocket.github.io/issues/190)
- Amends: browser credential retention in AGENTS.md, WEB.md, PRODUCT.md,
  DATA_AND_PRIVACY.md, ROADMAP.md, and THREAT_MODEL.md (TM-04/TM-05).

## Context

The owner explicitly requested a persistent token on a trusted browser, with a
concise risk notice, so closing tabs or restarting does not require copying a
GitHub PAT again. The previous memory/tab-only policy prevents that workflow.
The hosted app remains static and local-first. OAuth, a token broker, and a
passphrase vault are separate work.

## Decision

Replace the tab-only checkbox with **Remember token in this browser**, unchecked
by default for every library. Explain that anyone with access to the browser
profile may use the token. Save only after successful repository/library
validation and synchronization. The owner accepts browser-profile access and
same-origin script compromise as residual risks; no encryption guarantee is made.

Use a separate `<profile namespace>-credentials-v1` IndexedDB database with a
versioned credential bound to owner, repository, branch, and canonical library
ID. Do not change the library database schema or sync wire format. Startup
restores only an exact binding and resumes ordinary sync automatically. Existing
sessionStorage tokens remain usable in their tab but are never silently saved.
There is no extra unlock step or application retention deadline. The expiring,
selected-private-repository, Contents read/write PAT requirements remain.

Show remembered state in Sync settings. Unchecking removes persistent and legacy
session copies while keeping active memory connections. **Forget token** clears
memory and saved copies across tabs without deleting the library or outbox.
Profile deletion removes its token. Local forgetting does not revoke on GitHub.
Invalidation messages contain no token. Keep a non-secret revision after forget
so a validation begun before forgetting cannot re-create the saved credential.

Authentication/authorization, library mismatch, integrity, and upgrade failures
retain the existing fail-closed behavior and clear saved credentials too.
Transport/rate-limit failures retain them. Storage failure leaves the current
connection usable in memory with a notice. A failed attempt never persists a
new credential. Tokens never enter the library replica, outbox, exports,
protocol objects, service workers, logs, or publication artifacts.

## Compatibility and recovery

This is additive local-only storage, not a released library migration or protocol
change. Existing users must explicitly opt in. A rollback ignores the separate
credential database and asks for a token again; it must not import that store into
library data. Before rolling back, forget saved tokens, or remove only the
`-credentials-v1` databases through browser site storage tools. Preserve library
IndexedDB databases containing unsynced edits. Revoke an exposed token on GitHub.

## Verification

A persistence-boundary scenario verifies reopening, profile/repository/branch/
library binding, forgetting during validation, and profile deletion. Browser
verification exercises automatic restore, memory-only opt-out, cross-tab forget,
storage failure, and transient versus authentication failures with synthetic
credentials. Desktop/mobile evidence and deployable-artifact checks cover UI and
publication boundaries.
