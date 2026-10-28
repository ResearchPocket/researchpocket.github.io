# Browser workspace

The [hosted app](https://researchpocket.github.io/app/) is a private editing
workspace served as a static application. Your data lives in this browser's
IndexedDB storage; there is no ResearchPocket account or hosted application
backend. The browser and native CLI have separate local libraries until you
connect them through private sync.

## Choose a workspace

| Workspace | Use it for |
| --- | --- |
| **Zen** | Open or create Markdown documents, task lists, and saved-item references |
| **Library** | Save URLs, search, filter, favorite, and read sources in List or Graph |
| **Sync** | Connect a private data repository, inspect pending changes, and sync |
| **Settings** | Appearance, theme, reading preferences, and local library settings |

Zen is the default workspace. Use the navigation rail on desktop or the bottom
navigation on small screens. The Library's List/Graph switch changes how the
current results are presented. Settings includes the Kanagawa Wave theme along
with other presets; appearance preferences are local to the browser.

## Search and keyboard navigation

**Ctrl+Shift+P** opens the command palette for navigation, source/document
lookup, and creation actions. **/** focuses Library search outside a text
field. **Escape** closes a focused view or dialog where offered.

In Zen's **Open or create a document…** field, typing filters titles, arrow keys
select a row, Enter opens it, and **Ctrl+Enter** or **Cmd+Enter** creates a new
document. The [Zen guide](ZEN.md) covers editing and save timing.

The current browser update also offers `[[` completion and a touch-friendly
**Insert link** action in Zen bodies. Follow document links within Zen or saved
links in the Reader, and use **Linked from** to return to referencing documents.
These additions are beyond the published 2.3.0 browser. See
[Zen links and backlinks](ZEN.md#insert-links-and-follow-backlinks).

## Work offline

Once the app has loaded, saves and accepted edits can continue offline. They
commit to local storage and queue updates before synchronization. Offline work
does not require a token.

A known [offline-reload issue (#199)](https://github.com/ResearchPocket/researchpocket.github.io/issues/199)
can prevent a fresh offline load from opening the domain worker even when the
static shell is cached. Keep the working app open while offline; reopening may
require a connection until that issue is fixed. This does not discard already
committed local changes.

The pending-change count means work is durable on this device and still needs
to upload. It is not a remote-backup confirmation. Captured pages you have not
cached, source websites, and explicitly loaded external images can still need a
network connection. See [Capture and reading](READING.md).

Browser storage belongs to the browser profile and origin. Clearing site data,
removing a profile, or using temporary browsing can remove local work. Sync a
library before depending on remote recovery, and check pending changes before
removing it.

## Manage library profiles

The app supports separate local library profiles and a library selector. Each
profile has its own library storage and repository connection. Switching profiles
does not combine libraries. Use **Create a local library** for a new library or
**Restore an existing library** to recover one from its private repository.

A saved-item reference resolves within the active library, so opening a different
profile can change whether an ID is available. Keep unrelated projects in one
library with tags when you want their references to connect.

## Connect and remember a token

Follow [Sync and recovery](SYNC.md) to select a private data repository and a
fine-grained GitHub token. **Connection settings** is collapsed in the Sync
view; expand it to configure the connection. Pending changes appear separately
from connection details.

The token stays in JavaScript memory by default. **Remember token in this
browser** is off by default. Enable it only in a trusted browser: it saves the
validated credential locally, bound to the profile, repository, branch, and
library. GitHub's token expiry still applies.

Disable remembering to remove the saved copy while keeping the current page
connected. **Forget token** clears saved and active copies across tabs without
removing queued edits. Deleting a profile also removes its saved token.
Transient network errors do not erase a remembered token. Forgetting it does not
revoke it on GitHub.

## Technical details

For offline caching, persistence boundaries, CSP, cross-tab serialization, and
deployment, read the [browser architecture reference](../v2/WEB.md). For GitHub
scope, retention, and the limits of private repository storage, read
[Data, sync, and privacy](../v2/DATA_AND_PRIVACY.md).
