# ResearchPocket documentation

ResearchPocket keeps useful URLs and the thinking around them in a private,
local-first library. Save sources in the Library, read their excerpts and captured
pages, and use Zen to write documents and task lists that reference your saves.
Start locally in a browser or terminal; connect private GitHub sync when you need
another device.

The current published release is **ResearchPocket 2.3.0**. The
[latest release notes](../releases/v2.3.0.md) explain upgrades and compatibility.
Browser guides also cover the current Zen linking update: completion, links
between documents, and derived backlinks. These are browser changes beyond the
2.3.0 release; see [Zen links and backlinks](ZEN.md#insert-links-and-follow-backlinks).

## Start here

| I want to… | Read |
| --- | --- |
| Start without installing anything, or install the CLI | [Getting started](GETTING_STARTED.md) |
| Organize links, search, and explore their connections | [Save and organize sources](LIBRARY.md) |
| Write a document, keep todos, or reference saved items | [Zen documents](ZEN.md) |
| Keep technical documentation and research references together | [Documentation and references](REFERENCES.md) |
| Read an excerpt or capture a page as Markdown | [Capture and reading](READING.md) |
| Set up another device or recover a library | [Sync and recovery](SYNC.md) |

## What lives in your library

| Content | What it is | Where to use it |
| --- | --- | --- |
| Saved item | An HTTP(S) URL with a title, tags, favorite state, excerpt, and private note | Library, CLI, TUI |
| Excerpt | Bounded context about a source; editable and merged across devices | Reader and item editor |
| Private note | Your own explanation of why a saved source matters | Item editor, CLI, TUI |
| Captured page | Optional bounded Markdown retrieved by Firecrawl, stored separately from the excerpt | Reader's **Captured page** section |
| Zen document | Your authored Markdown, tasks, and references; up to 256 KiB | Zen, `research zen`, TUI documents workspace |

Saving a URL does not capture its full page. Creating a Zen document does not
require a URL. A reference in a document points to a save rather than making a
second copy of it.

## Choose an interface

The [browser app](BROWSER.md) stores a library in the current browser profile and
supports offline edits once loaded. The browser guide documents a known
offline-reload limitation. The CLI and TUI share
a native library in the platform data directory. They become replicas of the
same library when connected through [private sync](SYNC.md); opening the browser
app does not automatically open the native SQLite library.

Use the [CLI and TUI reference](../v2/CLI.md) for exact commands, flags,
keyboard controls, and machine-readable output. The
[data and privacy guide](../v2/DATA_AND_PRIVACY.md) explains storage, credentials,
and deletion. Contributors can start with the
[technical reference](TECHNICAL.md).

## Available now and planned work

2.3.0 includes local URL management, native browser capture, optional enrichment
and captured Markdown, private GitHub sync and restore, browser library profiles,
Zen documents, the TUI documents workspace, a derived browser library graph,
and optional token remembering in trusted browsers.

Selective public collections and publication, `research ui` and its loopback API,
broader import/export formats, and background-service installation remain planned.
The shipped importer reads V1 SQLite libraries. JSON and NDJSON command output
are available for scripts; they are not a canonical export/import round trip.

The [product contract](../v2/PRODUCT.md) and [roadmap](../v2/ROADMAP.md) include
target capabilities as well as shipped work. Use these user guides and release
notes to check what you can do today.
