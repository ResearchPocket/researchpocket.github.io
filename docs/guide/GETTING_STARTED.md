# Getting started

Choose the browser app for an installation-free start, or the CLI if you prefer
a terminal. Both let you work locally without a ResearchPocket account. GitHub
is needed only when you choose to synchronize.

## Start in a browser

1. Open the [ResearchPocket app](https://researchpocket.github.io/app/).
2. Choose **Create a local library**. If you already have a synced library,
   choose **Restore an existing library** and follow [Sync and recovery](SYNC.md).
3. Open **Library**, paste an absolute `https://` URL into its search/save field,
   and submit the save. On a small screen, use **Save a link**.
4. Open the save to read it; choose **Edit save** to add a title, excerpt, private
   note, or tags.
5. Open **Zen** to create a document or task list alongside your sources.

Zen is the default workspace once a library is open. The Library holds URLs;
Zen holds your writing. See [Browser workspace](BROWSER.md) for navigation.

Your library belongs to this browser profile. Clearing site data can erase
unsynced edits. Set up [private sync](SYNC.md) before relying on another device
to recover it. The public docs do not open or read your private library.

## Install the CLI

With Rust installed:

```sh
cargo install --locked research
research --version
```

The version described here is `research 2.3.0`. You can also download an archive
for Linux, macOS, or Windows from the
[releases page](https://github.com/ResearchPocket/researchpocket.github.io/releases)
and verify it against `SHA256SUMS`. The archives are unsigned; the
[2.3.0 release notes](../releases/v2.3.0.md) include a source-build alternative.

Create a library and save a URL:

```sh
research init
research add https://example.com/article --title "A useful source" --tag research
research list
research search research
```

Use the item ID printed by `research list` for later changes:

```sh
research edit "$ITEM_ID" --note "Compare with the prototype" --add-tag reviewed
```

`$ITEM_ID` in these guides means the actual UUID of your save. Document commands
use a separate `$DOC_ID` obtained from `research zen list`.

## Try Zen and the terminal workspace

```sh
research zen add --title "Research plan" --body "- [ ] Read the first source"
research zen list
research tui
```

In the TUI, press **Tab** to switch between saves and documents, **Enter** to
open a document, and **?** for help. The [Zen guide](ZEN.md) covers task lists,
references, document editing, and recovery.

## Add another device later

The browser library and native library use separate local storage. Connect them
to one private GitHub data repository to share the same work. On a fresh device,
connect or restore before adding anything so it can adopt your existing library.
Follow [Sync and recovery](SYNC.md) for repository and credential setup.

If you have a V1 database, use [Move from V1](../v2/MIGRATION.md) to import it
without modifying the original.

## Next steps

- [Save and organize sources](LIBRARY.md): tags, search, favorites, and the graph.
- [Documentation and references](REFERENCES.md): a workflow for reading and writing.
- [Capture and reading](READING.md): bookmarklets, enrichment, and captured pages.
- [CLI and TUI reference](../v2/CLI.md): all command options and output contracts.
