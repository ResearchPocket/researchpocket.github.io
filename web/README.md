# ResearchPocket web owner

This static app opens a private library from IndexedDB and keeps local actions
usable offline. A local action is durable before the interface reports success;
the header shows how many immutable updates still need to be synchronized. The
Private sync panel pulls and appends those updates through a separate private
GitHub repository without using Git history as application conflict resolution.

Use an expiring fine-grained PAT limited to the private data repository with
`Contents: read/write`. The app holds it in JavaScript memory by default. The
explicit tab-only option uses `sessionStorage`; no token is written to IndexedDB,
`localStorage`, an API URL, logs, or service-worker caches.

Install the WASM target and the CLI version pinned by the Rust crate once:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.126 --locked
```

```sh
npm ci
npm run verify
npm run dev
```

`npm` and `package-lock.json` define the canonical reproducible toolchain.
`npm run verify` runs the browser data contracts, strict type checking, the
design-system policy, the Rust/WASM build, the Vite production build, and the
deployable-artifact checks used by GitHub Pages.

After the locked `npm ci` install, Bun can also run the development script:

```sh
bun dev
```

Both commands start the public explainer at `http://localhost:5173/` and the
owner application at `http://localhost:5173/app/`. The development server
creates a fresh CSP nonce at startup for Vite's injected scripts and styles, so
CSS and hot reload work without allowing arbitrary inline content. Restart the
server after changing its configuration. Production builds do not contain this
development nonce.

`npm test` runs two focused contracts: a complete local commit and non-secret
sync configuration survive reopen while an interrupted replacement exposes none
of its writes; the GitHub adapter keeps credentials in headers and sends exact
immutable bytes without a replacement SHA.

`npm run build` first compiles `research-domain` for
`wasm32-unknown-unknown`, runs the matching `wasm-bindgen` CLI, type-checks the
app, checks the canonical design-system rules, creates the script-free landing
page and relative-path owner app in `dist/`, and rejects unsafe deployment
artifacts. The app-scoped service worker caches only same-origin owner-shell
resources and bypasses `api.github.com`.
