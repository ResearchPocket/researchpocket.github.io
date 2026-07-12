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
npm test
npm run dev
```

`npm test` runs two focused contracts: a complete local commit and non-secret
sync configuration survive reopen while an interrupted replacement exposes none
of its writes; the GitHub adapter keeps credentials in headers and sends exact
immutable bytes without a replacement SHA.

`npm run build` first compiles `research-domain` for
`wasm32-unknown-unknown`, runs the matching `wasm-bindgen` CLI, type-checks the
app, and creates the relative-path Pages build in `dist/`. The service worker
caches only same-origin application-shell resources and bypasses
`api.github.com`.
