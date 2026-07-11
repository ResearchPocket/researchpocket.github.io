# ResearchPocket web owner

This static app opens a private library from IndexedDB and keeps local actions usable offline. A local action is durable before the interface reports success; the header shows how many immutable updates still need to be synchronized. This slice never asks for or persists a GitHub token and does not pull or push remote data yet.

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

`npm test` runs the single browser-persistence contract: a complete local commit
survives reopen, while an interrupted replacement exposes none of its writes.

`npm run build` first compiles `research-domain` for `wasm32-unknown-unknown`, runs the matching `wasm-bindgen` CLI, type-checks the app, and creates the relative-path Pages build in `dist/`. The service worker caches only same-origin application-shell resources and bypasses `api.github.com`.
