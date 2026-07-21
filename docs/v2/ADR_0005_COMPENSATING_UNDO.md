# ADR 0005: Undo browser mutations with compensating updates

- Status: accepted
- Date: 2026-07-21
- Issue: [#83](https://github.com/ResearchPocket/researchpocket.github.io/issues/83)

## Context

The hosted owner applies every mutation immediately to its local Loro snapshot,
IndexedDB projection, immutable batch store, and synchronization outbox.
Removing an unsynchronized envelope would not undo the already-applied document
state, and the same envelope may already exist remotely. Rewriting or deleting
immutable operations would also violate the synchronization protocol.

Owners nevertheless need an immediate recovery path after accidentally adding,
editing, favoriting, tagging, deleting, or restoring a saved item.

## Decision

After each successful browser item mutation, the repository returns one bounded
in-memory undo token containing the compensating mutation, the exact resulting
item projection expected by that mutation, and any prior exact tag set needed to
restore an edit. The UI exposes the latest token through a visible Undo notice
and `Ctrl+Z` or `Cmd+Z`. A later successful item mutation replaces the token;
dismissal or page reload removes it.

Undo never removes or rewrites an operation, snapshot revision, batch, outbox
entry, or remote object. It applies the compensation through the same shared
WASM mutation boundary and atomically creates the next immutable envelope. If
the original operation was already synchronized, normal synchronization carries
the compensation afterward.

Before applying the compensation, the repository compares the item's current
allowlisted projection with the exact projection captured after the original
action. Any later local or remote difference makes the token stale and the undo
fails without mutation. This deliberately conservative precondition prevents an
older undo from overwriting newer work.

Compensations are:

- create → delete;
- delete → restore;
- restore → delete; and
- edit → restore only the prior changed scalar values, note text, favorite
  state, and exact tag set.

Undoing creation therefore leaves normal lifecycle history rather than
physically erasing the item. Deleted saves remain independently recoverable from
the archive even after the immediate undo token is gone.

## Consequences

- Undo converges across replicas because it is an ordinary later mutation.
- Both the mistaken action and its compensation remain in immutable local and
  remote history.
- Only the latest browser action is offered; this is not an unlimited revision
  history browser.
- Reloading clears the in-memory edit undo token. Lifecycle deletion remains
  recoverable through the archive.
- A stale undo asks the owner to review the newer item instead of guessing which
  fields to overwrite.

## Verification

- Build compensations for create, edit, delete, and restore.
- Restore nullable text, note, favorite state, and exact tags after an edit.
- Reject an undo token after any expected item field changes.
- Verify the web persistence, WASM, design-system, and production build checks.
