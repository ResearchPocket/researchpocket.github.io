# Sync and recovery

Private sync keeps one library current across your own browsers and computers.
Every accepted edit is stored locally first. GitHub transports immutable updates;
ResearchPocket merges library changes without asking you to merge Git branches.
Saves and Zen documents use the same connection.

## Prepare a private repository

1. Create an empty **private** GitHub repository for library data.
2. Create an expiring fine-grained personal access token limited to that repository.
3. Grant **Contents: read/write** for the selected repository.
4. Connect the device that already contains your work first.

Keep the public application source repository and your private data repository
separate. The owner token must not have write access to the repository serving
the application code. Syncing to a public data repository is not supported.

A private repository is access-controlled storage, not end-to-end encryption.
People or credentials with access can read its contents. Sync is not publication.

## Connect the browser

Open **Sync**, expand **Connection settings**, enter `OWNER/PRIVATE_REPOSITORY`,
and supply the token. Use the branch field if needed. The app validates the
remote before uploading. Leave **Remember token in this browser** off for a
memory-only connection, or enable it on a trusted browser.

Connected visible tabs pull on startup, focus, and network recovery, refresh
periodically, and coalesce local changes for upload. Manual sync is immediate.
The Sync view shows local pending work and the last result. Wait for the pending
queue to drain before treating a different device as a complete backup.

See [Browser workspace](BROWSER.md#connect-and-remember-a-token) for forgetting
and token retention.

## Connect the CLI or TUI

Set a token without putting it in a command-line argument:

```sh
printf 'Fine-grained GitHub token: ' >&2
IFS= read -r -s RESEARCHPOCKET_GITHUB_TOKEN
printf '\n' >&2
export RESEARCHPOCKET_GITHUB_TOKEN
research sync connect OWNER/PRIVATE_REPOSITORY
research sync run
research status
unset RESEARCHPOCKET_GITHUB_TOKEN
```

The example uses a POSIX-style shell. Native ResearchPocket accepts
`RESEARCHPOCKET_GITHUB_TOKEN` or `GH_TOKEN` and does not persist the PAT. Set it
before launching `research tui`; **s** connects or syncs from either workspace.

For periodic synchronization in a running foreground process:

```sh
research --format ndjson sync run --every 60
```

This is not a background-service installer. The [sync command reference](../v2/CLI.md#private-github-synchronization)
explains status, retries, limits, and machine output.

## Restore on a new device

In a new browser profile, choose **Restore an existing library** before saving
anything. Connect the existing private repository and wait for sync to finish.

For a native installation, start with an empty data directory:

```sh
research --data-dir /path/to/new/library init
research --data-dir /path/to/new/library sync connect OWNER/PRIVATE_REPOSITORY
research --data-dir /path/to/new/library sync run
research --data-dir /path/to/new/library list --limit 20
research --data-dir /path/to/new/library zen list
```

Provide the token through the environment first. Connecting a pristine replica
lets it adopt the remote library identity. Two independently edited libraries
cannot be combined by connecting them to the same repository; a mismatch stops
sync rather than discarding work. Do not copy a live SQLite file between devices
as a sync method.

Use 2.3.0 on your devices for the current behavior. Zen requires 2.2.1 or newer;
older clients do not see its documents. Review [release notes](../releases/v2.3.0.md)
before upgrades, especially if coming from preview clients.

## Recover from a failed cycle

| Symptom | Next step |
| --- | --- |
| Offline or a timeout | Keep local work; reconnect and retry sync |
| Rate limited | Wait for the retry window rather than repeatedly reconnecting |
| Expired or revoked token | Create an appropriately scoped token and reconnect |
| Library mismatch | Check repository/profile selection; preserve both local libraries |
| Integrity or upgrade-required error | Stop and inspect the reported error; do not overwrite immutable remote files |
| Missing captured-page content | Reconnect to fetch the separate content when opening the capture |

Pending edits remain queued when a network or authentication failure occurs.
Browser authentication and integrity failures may forget the credential while
retaining the queue. Repository races are transport retries, not library merge
conflicts; never force-push or edit operation files to resolve them.

## Backups and deletion

Remote sync can recover only successfully uploaded work. Unsynced changes live
on the current device. Before a migration, close native processes and copy the
complete data directory to offline backup storage. Retain the original V1 source
after [migration](../v2/MIGRATION.md).

Deletes are recoverable; immutable history is retained. Dropping a captured page
or forgetting a token does not securely erase previously synced content. See
[Data, sync, and privacy](../v2/DATA_AND_PRIVACY.md) and the
[protocol reference](../v2/SYNC_PROTOCOL.md) for details.
