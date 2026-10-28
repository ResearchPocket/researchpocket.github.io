# Zen link completion and backlinks verification

Issue: [#198](https://github.com/ResearchPocket/researchpocket.github.io/issues/198)

All browser checks used the headed `chrome-devtools` CLI in an isolated context,
with synthetic titles and example.com URLs. No owner data or token was used.

Verified:

- Clicking/editing the textarea dismisses the explicit picker without overwriting
  draft text. Reopening it inserts using a fresh selection; stale text/offsets
  are also rejected at acceptance.
- GFM footnote backlinks and escaped pipe labels in table cells pass a focused
  Markdown contract matching the reader's GFM syntax.

- `[[` filters local document/title/URL metadata; ArrowDown changes selection,
  Enter inserts a stable Markdown link, and Escape dismisses the picker while
  keeping the document and its draft open.
- Desktop suggestions appear at the caret; touch viewport uses a docked picker.
- The document delete action uses the shared SVG archive icon with a Delete document
  accessible label. First activation asks for confirmation; blurring cancels it.
- At 390 × 844 with mobile/touch emulation, Insert link opens the search field;
  tapping a document or saved item inserts it at the preserved selection and
  returns focus to the textarea.
- Following a link navigates internally. Document and item targets show their
  referring live documents in Linked from, and backlinks navigate to the source.
- Renaming Mobile reading to Reading on mobile updates the rendered link label
  without changing its UUID destination.
- Deleting the target changes its old link to document unavailable. The same
  deletion removes that document's outgoing mentions from an item's backlinks.
  Creating a new document with the old title does not retarget an old UUID link.
- In a loaded production app with networking disabled, completion and saving
  work. Reconnecting and reloading retains the link and pending outbox count.

Screenshots:

- [Desktop completion](./198-zen-desktop.png)
- [Mobile Insert link](./198-zen-mobile.png)
- [Linked from](./198-zen-backlinks.png)
- [Editor icon on mobile](./198-zen-delete-mobile.png)
- [Editor icon on desktop](./198-zen-delete-desktop.png)

Automated verification, from `web/`:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run check:design
bun run wasm
bunx vite build
bun run check:dist
```

All 34 web tests passed, including the focused Markdown reference/escaping
contracts. Native-to-WASM release compilation, design checks, production build,
and artifact checks passed. Rust source and synchronization formats are unchanged.
Vite emits its existing large-chunk advisory.

## Remaining checks

Real iOS and Android software keyboards require a physical device check; touch
viewport emulation does not establish keyboard behavior on those platforms.

A separate production bootstrap failure prevents a fully offline reload from
opening the domain worker, although the static shell loads. This existing
worker/cache boundary is recorded in [#199](https://github.com/ResearchPocket/researchpocket.github.io/issues/199).
An offline edit made in a loaded app was preserved through reconnect/reload.
