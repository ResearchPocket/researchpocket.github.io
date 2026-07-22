import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(webRoot, "dist");
const failures = [];

function walk(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

for (const requiredFile of [
  "index.html",
  "app/index.html",
  "docs/index.html",
  "overview/index.html",
  "sw.js",
  "manifest.webmanifest",
  "asset-manifest.json",
  "favicon.svg",
  "llms.txt",
  "og.png",
  "robots.txt",
  "sitemap.xml",
  ".nojekyll",
  "ResearchPocket/index.html",
  "ResearchPocket/app/index.html",
  "ResearchPocket/manifest.webmanifest",
  "ResearchPocket/redirect.js",
]) {
  if (!existsSync(resolve(distRoot, requiredFile))) {
    failures.push(`Missing production artifact: ${requiredFile}`);
  }
}

const files = existsSync(distRoot) ? walk(distRoot) : [];
const sourceMaps = files.filter((file) => file.endsWith(".map"));
if (sourceMaps.length > 0) {
  failures.push(
    `Source maps are not deployable: ${sourceMaps.map((file) => relative(distRoot, file)).join(", ")}`,
  );
}

const artifacts = files.map((file) => ({ file, bytes: readFileSync(file) }));
const htmlArtifacts = artifacts.filter(({ file }) => extname(file) === ".html");
const textExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);
const text = artifacts
  .filter(({ file }) => textExtensions.has(extname(file)))
  .map(({ bytes }) => bytes.toString("utf8"))
  .join("\n");

for (const [name, pattern] of [
  ["source map reference", /sourceMappingURL=/i],
]) {
  if (pattern.test(text)) {
    failures.push(`Production artifact contains ${name}`);
  }
}

for (const [name, pattern] of [
  ["unsafe-inline CSP source", /unsafe-inline/i],
  ["development CSP nonce", /nonce-[a-z0-9]+/i],
]) {
  const matchingFiles = htmlArtifacts
    .filter(({ bytes }) => pattern.test(bytes.toString("utf8")))
    .map(({ file }) => relative(distRoot, file));
  if (matchingFiles.length > 0) {
    failures.push(`Production HTML contains ${name}: ${matchingFiles.join(", ")}`);
  }
}

for (const [name, markers] of [
  ["GitHub token prefix", ["github_pat_"]],
  ["legacy Pocket credential", ["POCKET_ACCESS_TOKEN", "POCKET_CONSUMER_KEY"]],
  ["private test sentinel", ["PRIVATE_TOKEN_SENTINEL", "PRIVATE_LANGUAGE_SENTINEL"]],
]) {
  const encodedMarkers = markers.map((marker) => Buffer.from(marker, "ascii"));
  const matchingFiles = artifacts
    .filter(({ bytes }) => encodedMarkers.some((marker) => bytes.includes(marker)))
    .map(({ file }) => relative(distRoot, file));
  if (matchingFiles.length > 0) {
    failures.push(
      `Production artifact contains ${name}: ${matchingFiles.join(", ")}`,
    );
  }
}

const documents = ["index.html", "app/index.html", "docs/index.html", "overview/index.html"];
for (const document of documents) {
  const path = resolve(distRoot, document);
  if (!existsSync(path)) continue;
  const html = readFileSync(path, "utf8");
  if (!html.includes("script-src 'self' 'wasm-unsafe-eval'")) {
    failures.push(`${document} is missing the expected script CSP`);
  }
  if (!html.includes("style-src 'self'")) {
    failures.push(`${document} is missing the expected style CSP`);
  }
  if (/unsafe-inline|nonce-[a-z0-9]+/i.test(html)) {
    failures.push(`${document} contains an unsafe or development-only CSP source`);
  }

  const runtimeTags = html.match(/<(?:img|link|script)\b[^>]*>/gi) ?? [];
  const externalRuntimeTag = runtimeTags.find((tag) => {
    if (/<(?:img|script)\b/i.test(tag)) {
      return /\bsrc=["']https?:/i.test(tag);
    }
    return (
      /\brel=["'](?:stylesheet|preload|modulepreload|icon|manifest)["']/i.test(tag) &&
      /\bhref=["']https?:/i.test(tag)
    );
  });
  if (externalRuntimeTag) {
    failures.push(`${document} loads a third-party runtime asset`);
  }
}

const docsPath = resolve(distRoot, "docs/index.html");
if (existsSync(docsPath)) {
  const docs = readFileSync(docsPath, "utf8");
  if (!docs.includes('name="robots" content="index, follow"')) {
    failures.push("The public reference guide is not indexable");
  }
  if (!docs.includes('rel="canonical" href="https://researchpocket.github.io/docs/"')) {
    failures.push("The public reference guide canonical URL is incorrect");
  }
  if (docs.includes('rel="manifest"') || docs.includes("research_domain_bg")) {
    failures.push("The public reference guide is coupled to owner-app resources");
  }
}

const landingPath = resolve(distRoot, "index.html");
if (existsSync(landingPath)) {
  const landing = readFileSync(landingPath, "utf8");
  if (!landing.includes('name="robots" content="index, follow"')) {
    failures.push("The public landing page is not indexable");
  }
  if (!landing.includes('property="og:image"')) {
    failures.push("The public landing page is missing its social preview metadata");
  }
  if (!landing.includes('content="https://researchpocket.github.io/"')) {
    failures.push("The public landing page does not identify the organization site URL");
  }
  if (!landing.includes('href="https://researchpocket.github.io/"')) {
    failures.push("The public landing page canonical URL is not the organization site");
  }
}

for (const [file, expected] of [
  ["robots.txt", "Sitemap: https://researchpocket.github.io/sitemap.xml"],
  ["sitemap.xml", "<loc>https://researchpocket.github.io/</loc>"],
  ["sitemap.xml", "<loc>https://researchpocket.github.io/docs/</loc>"],
  ["llms.txt", "https://researchpocket.github.io/app/"],
  ["llms.txt", "https://researchpocket.github.io/docs/"],
]) {
  const path = resolve(distRoot, file);
  if (existsSync(path) && !readFileSync(path, "utf8").includes(expected)) {
    failures.push(`${file} does not point to the organization site`);
  }
}

const assetManifestPath = resolve(distRoot, "asset-manifest.json");
if (existsSync(assetManifestPath)) {
  const assetManifest = JSON.parse(readFileSync(assetManifestPath, "utf8"));
  if (!assetManifest["app/index.html"] || !assetManifest["docs/index.html"]) {
    failures.push("The Vite manifest is missing the owner or reference entry");
  } else {
    const collectEntryFiles = (entryKey, collected = new Set()) => {
      if (collected.has(entryKey)) return collected;
      collected.add(entryKey);
      const entry = assetManifest[entryKey];
      if (!entry) return collected;
      if (typeof entry.file === "string") collected.add(entry.file);
      for (const file of entry.css ?? []) collected.add(file);
      for (const file of entry.assets ?? []) collected.add(file);
      for (const importedEntry of entry.imports ?? []) {
        collectEntryFiles(importedEntry, collected);
      }
      return collected;
    };
    const appFiles = collectEntryFiles("app/index.html");
    const docsFiles = collectEntryFiles("docs/index.html");
    if (appFiles.has(assetManifest["docs/index.html"].file)) {
      failures.push("The owner application dependency closure contains the docs entry");
    }
    if ([...docsFiles].some((file) => file.endsWith(".wasm"))) {
      failures.push("The public reference dependency closure contains WASM");
    }
  }
}

const appPath = resolve(distRoot, "app/index.html");
if (existsSync(appPath)) {
  const app = readFileSync(appPath, "utf8");
  if (!app.includes('name="robots" content="noindex, nofollow"')) {
    failures.push("The private owner application is missing its noindex policy");
  }
}

const manifestPath = resolve(distRoot, "manifest.webmanifest");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.scope !== "/app/" || manifest.start_url !== "/app/") {
    failures.push("The web manifest must remain scoped to the owner application");
  }
  if (manifest.id !== "/ResearchPocket/app/") {
    failures.push("The web manifest must preserve the installed application identity");
  }
  if (manifest.icons?.[0]?.src !== "/favicon.svg") {
    failures.push("The web manifest icon must resolve from the organization root");
  }

  const compatibilityManifestPath = resolve(
    distRoot,
    "ResearchPocket/manifest.webmanifest",
  );
  if (
    existsSync(compatibilityManifestPath) &&
    readFileSync(compatibilityManifestPath, "utf8") !==
      readFileSync(manifestPath, "utf8")
  ) {
    failures.push("The compatibility manifest must match the root manifest");
  }
}

for (const [file, canonical] of [
  ["ResearchPocket/index.html", "https://researchpocket.github.io/"],
  ["ResearchPocket/app/index.html", "https://researchpocket.github.io/app/"],
]) {
  const path = resolve(distRoot, file);
  if (!existsSync(path)) continue;
  const redirect = readFileSync(path, "utf8");
  if (!redirect.includes('name="robots" content="noindex, nofollow"')) {
    failures.push(`${file} must remain excluded from search indexes`);
  }
  if (!redirect.includes(`rel="canonical" href="${canonical}"`)) {
    failures.push(`${file} does not identify its canonical destination`);
  }
  if (!redirect.includes("redirect.js")) {
    failures.push(`${file} does not load the shared compatibility redirect`);
  }
  if (!redirect.includes("script-src 'self'")) {
    failures.push(`${file} does not restrict its redirect script to this origin`);
  }
  if (/<script\b[^>]*\bsrc=["']https?:/i.test(redirect)) {
    failures.push(`${file} loads an external redirect script`);
  }
}

const compatibilityScriptPath = resolve(
  distRoot,
  "ResearchPocket/redirect.js",
);
if (existsSync(compatibilityScriptPath)) {
  const compatibilityScript = readFileSync(compatibilityScriptPath, "utf8");
  for (const requiredMarker of [
    "window.location.search",
    "window.location.hash",
    "research-pocket-shell-v1",
    "research-pocket-shell-v2",
  ]) {
    if (!compatibilityScript.includes(requiredMarker)) {
      failures.push(
        `The compatibility redirect is missing migration behavior: ${requiredMarker}`,
      );
    }
  }
}

const serviceWorkerPath = resolve(distRoot, "sw.js");
if (existsSync(serviceWorkerPath)) {
  const serviceWorker = readFileSync(serviceWorkerPath, "utf8");
  if (!serviceWorker.includes('collectEntry("app/index.html")')) {
    failures.push("The owner service worker does not scope precaching to the app entry");
  }
  if (serviceWorker.includes("Object.values(manifest)")) {
    failures.push("The owner service worker precaches unrelated website entries");
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Production artifact checks passed for ${files.length} files.`);
