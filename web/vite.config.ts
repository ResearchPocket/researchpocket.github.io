import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const productionScriptPolicy = "script-src 'self' 'wasm-unsafe-eval';";
const productionStylePolicy = "style-src 'self';";

function developmentCsp(nonce: string): Plugin {
  return {
    name: "researchpocket-development-csp",
    apply: "serve",
    transformIndexHtml(html) {
      if (
        !html.includes(productionScriptPolicy) ||
        !html.includes(productionStylePolicy)
      ) {
        throw new Error("Expected the production CSP directives in index.html");
      }

      return html
        .replace(
          productionScriptPolicy,
          `script-src 'self' 'wasm-unsafe-eval' 'nonce-${nonce}';`,
        )
        .replace(
          productionStylePolicy,
          `style-src 'self' 'nonce-${nonce}';`,
        );
    },
  };
}

export default defineConfig(({ command }) => {
  const nonce =
    command === "serve"
      ? globalThis.crypto.randomUUID().replaceAll("-", "")
      : undefined;

  return {
    base: "./",
    build: {
      manifest: "asset-manifest.json",
      // Firefox fetches <link rel="modulepreload"> under default-src, which is
      // 'none' here, so preloading breaks the page it is meant to speed up.
      // The polyfill is worse: it is also a static import of every entry, so a
      // blocked fetch takes the whole module graph down. Nothing this app
      // needs — WASM, Web Locks, IndexedDB — exists in a browser that lacks
      // modulepreload, so there is nothing to gain by keeping either.
      modulePreload: false,
      rollupOptions: {
        input: {
          app: "app/index.html",
          docs: "docs/index.html",
          landing: "index.html",
          overview: "overview/index.html",
        },
      },
      sourcemap: false,
      target: "es2022",
    },
    html: nonce ? { cspNonce: nonce } : undefined,
    plugins: [react(), ...(nonce ? [developmentCsp(nonce)] : [])],
    server: {
      fs: {
        allow: [".."],
      },
    },
  };
});
