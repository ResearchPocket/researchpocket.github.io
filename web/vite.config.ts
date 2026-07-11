import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  build: {
    manifest: "asset-manifest.json",
    sourcemap: false,
    target: "es2022",
  },
  plugins: [react()],
});
