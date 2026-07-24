# Your data, sync, and privacy

ResearchPocket is local first. Saving, editing, searching, deleting, and
restoring links does not require a ResearchPocket account or an always-running
server.

## Where the library lives

The native CLI and TUI keep their working library in the platform data
directory. SQLite makes local search and editing fast, but it is not copied to
GitHub and is not the synchronization format.

The browser app keeps its local copy and pending changes in IndexedDB for that
browser profile. Clearing site data removes that local copy, so connect private
sync before relying on the browser as the only home for a library.

An optional private GitHub repository stores immutable synchronization updates.
Only people and credentials with access to that repository can read them.

## How synchronization works

Every save or edit commits locally first and creates an immutable update for
later delivery. A client pulls unseen updates, applies them through the shared
ResearchPocket data model, and then uploads its queued updates.

GitHub stores and transports those files. Git commit order, merges, rebases,
timestamps, and branch history never decide which title, note, tag, or lifecycle
state wins.

This gives ResearchPocket a few useful properties:

- editing can continue offline;
- retries and duplicate downloads do not duplicate a change;
- concurrent note edits preserve text from both clients;
- repository races keep local changes queued instead of asking for a Git merge;
- changed bytes at an existing immutable path stop sync as an integrity error;
  and
- saving the same URL twice keeps two separate items.

Run sync explicitly:

```sh
research sync run
```

Or keep it active in the foreground:

```sh
research --format ndjson sync run --every 60
```

## Credentials

Native GitHub credentials belong in the operating-system credential store or a
separate local credential file. They never belong in SQLite, link metadata,
notes, synchronization updates, exports, or a public repository.

The browser app keeps its fine-grained GitHub token in memory by default.
Optional session storage lasts only for the current browser session. The token
is never stored in localStorage, IndexedDB, a URL, generated output, analytics,
or the service-worker cache.

Use a fine-grained token limited to the one private data repository with
Contents read/write access. Do not give that token access to unrelated
repositories.

## Enrichment privacy

Direct enrichment fetches the saved public URL from the current device.
ResearchPocket rejects private and special network addresses and applies
redirect, size, and timeout limits.

Firecrawl is an explicit third-party option. When selected, the target URL is
sent to the configured Firecrawl service. The credential remains local and is
not written into the library or synchronization data.

The browser-capture URI never accepts a provider or credential.

## Backups and recovery

Before an upgrade that includes a migration, close every ResearchPocket process
and copy the complete native data directory to offline storage. Release notes
call out migrations and coordinated upgrades.

A private sync repository provides remote durability, but it is not a
substitute for every backup:

- keep the original V1 database after import;
- retain an offline backup before a coordinated protocol upgrade;
- do not edit or delete immutable operation files by hand; and
- treat a changed immutable path as a possible corruption or credential
  compromise.

On a new browser profile, choose **Restore an existing library** before making
the first local edit. On a new native device, initialize the intended data
directory, connect it to the existing private repository, and synchronize.

## Public sharing

ResearchPocket 2.0.1 does not publish selected collections. The hosted browser
app is a private owner surface, not a public library.

Never place a private database, token, synchronization update, operation pack,
credential file, or unredacted export in a public repository or issue.
