# ResearchPocket V2 Design System

Status: canonical visual and interaction contract for every V2 web surface

This system applies to the hosted owner application, the future loopback web
interface, the project landing page, and selective public collection views. A
surface may expose different capabilities, but it must not invent another
visual language or styling toolchain.

## Stack decision

| Concern | Canonical choice | Boundary |
| --- | --- | --- |
| UI | React 19 and TypeScript | Interface state and semantic markup only |
| Build | Vite | Static, relative-path output for local embedding and Pages |
| Domain | Rust compiled to WASM | Validation, mutation, merge, and projection semantics |
| Browser persistence | IndexedDB through `idb` | Private local replica and durable outbox |
| Styling | Native CSS with custom-property tokens | No runtime styling dependency |
| Package workflow | npm with committed `package-lock.json` | `npm ci` is the reproducible install |
| Hosting | GitHub Pages through pinned Actions | Credential-free static shell only |

Tailwind is not part of V2. The owner application has a small, stable set of
layout and control patterns, so a utility compiler would add an abstraction
without removing meaningful application complexity. V2 must never download or
execute a standalone styling binary. If the product eventually outgrows native
CSS, replacing this decision requires a tracked ADR and must preserve the token
and artifact contracts below.

## Principles

### Function before decoration

Every visible element must communicate content, hierarchy, state, or an action.
Do not add ornamental illustrations, floating shapes, decorative cards, fake
terminal chrome, or marketing copy inside the owner workspace.

### Quiet density

ResearchPocket is an editor for a personal library. Prefer one content plane,
short labels, compact controls, rules between records, and readable line
lengths. Use whitespace to separate tasks, not to create oversized hero areas.

### State is explicit

Sync, local persistence, pending work, destructive actions, and lifecycle state
must have text labels. Color may reinforce state but may not be its only signal.

### No motion dependency

The interface uses no animations or transitions. Feedback is immediate state,
text, focus, or a native dialog. Functionality must not depend on hover, motion,
or a pointer device.

### Self-hosted type, native controls

Use the bundled Berkeley Mono WOFF2 webfonts with `ui-monospace` and `monospace`
as local fallbacks. Use semantic HTML, native controls where practical, and
first-party text instead of icon packages. Owner mode may load the reviewed
font files only from the same-origin Vite artifact; external font hosts, images,
analytics, and runtime assets remain prohibited.

## Source architecture

The styles load in a fixed order:

1. `web/src/styles/tokens.css` defines all visual decisions and preference
   overrides.
2. `web/src/styles/base.css` establishes element behavior, focus, controls, and
   shared accessibility utilities.
3. `web/src/styles/app.css` composes landing, onboarding, workspace, and
   component patterns exclusively from tokens.

The script-free landing document links these files directly in that order. The
owner application imports the same order from its TypeScript entry so Vite can
extract one shared first-party stylesheet for both production documents.

Raw colors may appear only in `tokens.css`. Component styles use semantic token
names rather than palette names so light, dark, and increased-contrast modes do
not require component overrides. Border radius, control height, spacing, type,
measure, and layout widths follow the same rule.

The dependency-free `npm run check:design` gate enforces the file order, required
tokens, bundled font sources, color boundary, tokenized radius, and the
prohibition on gradients, shadows, filters, transitions, and animations.

## Visual language

### Color

The canonical dark palette uses warm cream text on a brown-black background,
with muted cream for primary emphasis, teal for state and selection, and indigo
for focus and secondary emphasis. Surfaces, borders, muted text, and destructive
states are derived only from those five source colors. Hierarchy should primarily
come from rules, spacing, weight, and labels rather than adding palette entries.

### Type

All surfaces use the self-hosted Berkeley Mono family, falling back to the
system UI monospace when the webfont is unavailable. Regular, italic, bold, and
bold italic WOFF2 sources are bundled locally; the desktop font files are not.
Body copy remains at a readable size and line height. Headings are modest,
weight-based, and sentence case. Uppercase is reserved for short metadata labels
such as `local`, `remote`, and item source.

### Space and rules

Use the eight-step spacing scale. Major workspace sections use a strong rule;
records and related metadata use the standard rule. Avoid nested containers when
a heading, rule, or spacing interval establishes the relationship.

### Shape

Controls use the single radius token. Tags and statuses are rectangular labels,
not pills. Do not use decorative shadows, glass effects, gradients, or raised
card stacks.

## Layout

The owner workspace exposes compact Library and Sync views. Library is the
default; only one workflow is visible at a time. Capture is a `New save` action
that opens a focused dialog rather than occupying a permanent view. The workspace
bar reports active and pending counts without becoming a second navigation system.

Forms use label/value rows on wide screens and one column on narrow screens.
Library records use one dense text column and a trailing action rail. Every row
is limited to a title, metadata/tags, and one authored-context preview. Buttons
remain content-sized, use compact icon controls for row actions, and never force
a record past three text lines. The page must work from 320 CSS pixels through
wide desktop screens without horizontal page overflow.

The public landing page uses a wider editorial reading layout at `/`; the owner
application lives at `/app/`. Both use the same tokens, typography, controls,
rules, states, and responsive breakpoints. The root must not load the owner
JavaScript/WASM bundle or initialize private browser storage.

## Patterns

### Buttons

Primary buttons are reserved for the one committing action in a form or task.
Secondary buttons cancel or remove temporary access. Text actions are suitable
for record-level edit, restore, and delete controls. Controls use the compact
system height, remain content-sized, and retain a visible focus outline.

### Fields

Every field has a persistent text label. Placeholder text is an example, never a
label. Optionality and formatting hints stay adjacent to the label. Errors use a
role appropriate to their urgency and identify the failed task in text.

Library search is one compact toolbar: a single search field, an inline clear
action, and adjacent lifecycle filters. It does not introduce a separate search
page or large filter controls. Query filtering is deferred so typing remains
responsive while the previous result set stays visible. Advanced controls expose
field scope, lifecycle, favorites, ordering, and searchable exact-tag filters.
Multiple tag filters support explicit `all` and `any` matching.

Tag editing uses one shared chip input in capture and edit. Existing tags appear
as bounded autocomplete suggestions; Enter or comma accepts a suggestion or a
new exact tag, Backspace removes the last selected tag, and every chip has an
explicit remove action. The control never silently changes tag spelling.

### Status

Repository and sync status use a small indicator plus explicit text. Pending
work always shows whether it is local, queued, or synchronized. Never imply that
a local commit is remotely backed up.

### Library records

Records form one ordered list separated by rules. Source, title, authored
context, tags, time, lifecycle, and actions stay in predictable order. Long text
is truncated in the list and remains available in the edit view. Favorite state
uses `aria-pressed`; deleted records remain recoverable and visually subordinate
without becoming unreadable. Results mount in explicit 100-row batches, offscreen
records use CSS rendering containment, and search follows a deferred query so
large libraries do not block input.

### Dialogs

Use the native `dialog` element for focused editing. It is a compact dialog on
larger screens and an edge-to-edge edit surface on phones, with a sticky app bar,
scrollable fields, and sticky actions above the device safe area. Move focus into
the dialog, support Escape, prevent interaction behind it, and return focus to
the control that opened it.

## Accessibility contract

- Use landmarks and one logical heading hierarchy per view.
- Preserve semantic labels and accessible names for every control.
- Keep keyboard focus visible in every color scheme.
- Keep action targets compact, clearly separated, and fully operable by touch.
- Do not communicate state by color alone.
- Respect increased contrast and reduced motion preferences.
- Keep DOM order and visual reading order aligned.
- Test initialized, empty, populated, deleted, error, and dialog states.

## Build and deployment contract

The canonical clean-room workflow is:

```sh
cd web
npm ci
npm run verify
```

`npm run verify` runs browser persistence/sync contracts and then the production
build. The build compiles Rust/WASM, type-checks TypeScript, checks the design
system, emits the static root and owner app, and checks the final artifact.
GitHub Pages invokes the same command; it does not contain a second build recipe.

The artifact check rejects source maps, source-map references, development CSP
nonces, `unsafe-inline`, external runtime assets, credential markers, and
private test sentinels across text and binary artifacts. It also requires an
indexable root landing document, a noindex owner document, an app-scoped
manifest, and noindex same-origin redirects for the retired project paths.
Deployment uploads only `web/dist` and uses no owner credential.

## Change rule

New web work starts with these tokens and patterns. Add a token only when an
existing semantic role cannot represent the requirement across all surfaces.
Add a component pattern only after the same interaction appears more than once
or has a durable accessibility contract. Exceptions require an issue explaining
the user need; visual preference alone is not sufficient.
