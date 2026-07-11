import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(webRoot, "..");
const generatedDirectory = resolve(webRoot, "src/generated");
const expectedWasmBindgenVersion = "wasm-bindgen 0.2.126";
const wasmArtifact = resolve(
  repositoryRoot,
  "target/wasm32-unknown-unknown/release/research_domain.wasm",
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function verifyWasmBindgen() {
  const result = spawnSync("wasm-bindgen", ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
  });

  if (result.error || result.status !== 0) {
    console.error(
      "wasm-bindgen 0.2.126 is required. Install it with `cargo install wasm-bindgen-cli --version 0.2.126 --locked`.",
    );
    process.exit(1);
  }

  if (result.stdout.trim() !== expectedWasmBindgenVersion) {
    console.error(
      `Expected ${expectedWasmBindgenVersion}, but found ${result.stdout.trim()}.`,
    );
    process.exit(1);
  }
}

verifyWasmBindgen();
rmSync(generatedDirectory, { force: true, recursive: true });

run("cargo", [
  "build",
  "--locked",
  "--manifest-path",
  "crates/research-domain/Cargo.toml",
  "--release",
  "--target",
  "wasm32-unknown-unknown",
]);

run("wasm-bindgen", [
  wasmArtifact,
  "--out-dir",
  generatedDirectory,
  "--out-name",
  "research_domain",
  "--target",
  "web",
  "--typescript",
]);
