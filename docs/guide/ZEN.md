# Zen documents

Zen is a small writing workspace beside your saved URLs. Use a document for a
reading plan, a project outline, working notes, or a checklist that refers back
to the sources in your library. Documents work offline and synchronize through
the same private connection as saves.

## Create and open a document in the browser

1. Open **Zen** in the app.
2. Type a title in **Open or create a document…**.
3. Choose **New document**, or press **Ctrl+Enter** or **Cmd+Enter** to create it.
4. Write in the document body. Choose **view** to read the rendered Markdown.

Typing in the Zen input filters existing documents by title. Use the arrow keys
and Enter to open a result. The list shows edit times and task progress without
loading every body. This input does not search document body text.

An empty document opens in **edit** mode; an existing document opens in **view**
mode. Change the title directly above the body. The title saves when its field
loses focus; the body saves when it loses focus or you switch to **view**. Let
the save finish before closing the tab. Escape closes a focused document; the
**Zen** breadcrumb also returns to the document list.

## Write Markdown and todos

Use headings, paragraphs, lists, links, block quotes, fenced code blocks, and
GitHub-style task lists:

```markdown
# Investigate sync recovery

Keep the scope small and record the sources below.

- [x] Save the protocol reference
- [ ] Compare retry behavior
- [ ] Write down open questions

> Check the original source before relying on a summary.
```

In **view** mode, click a checkbox to mark a task done or reopen it. A task is
ordinary Markdown text: changing `[ ]` to `[x]` by hand has the same effect as
clicking. Progress counts come from those task lines.

Each body is limited to **256 KiB of UTF-8 text**, not 256,000 characters. The
browser shows its byte budget and refuses an oversized body until it is shorter.
Keep large reference pages as saved URLs or captured pages rather than pasting
them into Zen. Documents do not store attachments or PDFs.

## Reference a saved item

A normal web link points directly to a page. A saved-item mention points to an
item in your library using its UUID:

```markdown
Read [the protocol reference](research:item/01900000-0000-7000-8000-000000000001)
before implementing retries.
```

Replace the example UUID with an actual item ID from `research list`. You can
also find an item's ID in its open Reader URL after `#item=`. You can type the
Markdown directly, or use the current browser's link picker described below.

When rendered, a mention shows the save's current title and host. Renaming that
save updates the rendered reference without rewriting your document. The current
browser opens an active saved-item link in its local Reader; the 2.3.0 browser
opens the saved URL.
A deleted save appears as a non-clickable **deleted save** marker; an unknown
ID appears **unresolved**.
The authored Markdown remains available in either case.

Mentions are local references, not public share links. They resolve against the
library you currently have open. See [Documentation and references](REFERENCES.md)
for a complete reading-plan example and graph connections.

## Insert links and follow backlinks

The current browser update adds link completion, document-to-document links,
and **Linked from** views. These changes extend the published 2.3.0 browser;
they do not add a native CLI or TUI completion picker.

1. Open a Zen document and choose **edit**.
2. Type `[[` followed by part of a document title, saved-item title, or URL.
3. Use Up/Down and Enter to choose an existing result. Escape dismisses the
   suggestions without closing the document.
4. On a phone, choose **Insert link**, search, and tap the result instead.
5. Switch to **view** and follow the link to open the document or saved item's
   local Reader.

Choosing a result inserts ordinary Markdown with the target UUID. A link to
another document looks like this:

```markdown
Continue in [the project plan](research:zen/01900000-0000-7000-8000-000000000003).
```

Renaming the target updates its displayed title. Suggestions omit deleted
targets and the current document. A missing or deleted document remains
visibly unavailable rather than binding to another document with a matching
title. Choosing a result is explicit: typing `[[` does not create a document
or turn a title into a permanent reference by itself.

An open document or saved item has a **Linked from** list of live Zen documents
that reference it. Select an entry to go back to the source document. The list
is derived locally while the target is open and works with locally available
documents offline. It is not a persistent backlink database or a new sync
payload. It can show a loading or failure state while checking documents.

Completion is currently available in Zen bodies, not saved-item private notes.
Older readers may not render the new `research:zen/…` links; the Markdown is
retained. [ADR 0014](../v2/ADR_0014_ZEN_LINK_COMPLETION.md) records compatibility
and the relationship boundary.

## Use Zen from the CLI

Create a document from a Markdown file:

```sh
research zen add --title "Reading plan" --body-file ./reading-plan.md --tag project
research zen list
research zen show "$DOC_ID"
```

Use standard input for generated or piped text:

```sh
printf '%s\n' '- [ ] Read the reference' '- [ ] Test the example' | \
  research zen add --title "Today" --body-file -
```

Update a title, tags, or the body:

```sh
research zen edit "$DOC_ID" --title "Reviewed sources" --add-tag reviewed
research zen edit "$DOC_ID" --body-file ./reading-plan.md
research zen list --format json
research zen show "$DOC_ID" --format json
```

`list` returns document metadata, including size and task counts. `show` loads
one body. Item and document commands use separate machine records; consult the
[CLI reference](../v2/CLI.md#zen-documents) for flags and schemas.

## Use the TUI documents workspace

Run `research tui` and press **Tab** to enter **documents**.

| Key | Action |
| --- | --- |
| `a` | Create a document |
| `/` | Filter by title and tag text |
| Enter or `o` | Open a document |
| `e` | Edit the selected document |
| `d` | Cycle active, all, and deleted documents |
| `x` / `r` | Delete with confirmation / restore |
| `s` | Connect or run private sync |

Inside an open document, move to a task line and press **Space** or **t** to
toggle it. **Ctrl+G** edits the body in `VISUAL` or `EDITOR`; **R** reloads the
local document; **Esc** or **q** closes it. Whole-body forms and external-editor
saves reject a stale buffer if another edit arrived; the TUI preserves the
rejected draft in a temporary file and reports its path.

## Sync, delete, and restore

Document bodies merge at character level. Edits to different tasks can survive
concurrent offline work. Sync still needs a successful connection to deliver
changes to other devices; the pending count includes documents and saves.
Upgrade every device to a Zen-capable release (2.2.1 or newer).

The browser's delete control asks for a second click. Native recovery uses:

```sh
research zen delete "$DOC_ID"
research zen restore "$DOC_ID"
```

The TUI also exposes deleted documents through its lifecycle filter. Deletion
is recoverable, and retained sync history is not secure erasure. Zen titles,
bodies, and IDs stay private and are excluded from publication. Public
publication itself remains planned. Read [Data, sync, and privacy](../v2/DATA_AND_PRIVACY.md)
for storage and history limits.
