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
