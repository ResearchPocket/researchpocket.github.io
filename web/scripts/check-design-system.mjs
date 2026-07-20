import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stylesRoot = resolve(webRoot, "src/styles");
const fontsRoot = resolve(webRoot, "src/assets/fonts");
const requiredFiles = ["tokens.css", "base.css", "app.css"];
const requiredFonts = [
  "TX-02-Regular.woff2",
  "TX-02-Oblique.woff2",
  "TX-02-Bold.woff2",
  "TX-02-BoldOblique.woff2",
];
const requiredTokens = [
  "--color-canvas",
  "--color-surface",
  "--color-text",
  "--color-text-muted",
  "--color-border",
  "--color-accent",
  "--color-danger",
  "--color-focus",
  "--control-height",
  "--radius",
];
const failures = [];

const files = readdirSync(stylesRoot).filter((file) => file.endsWith(".css"));
for (const requiredFile of requiredFiles) {
  if (!files.includes(requiredFile)) {
    failures.push(`Missing required stylesheet: ${requiredFile}`);
  }
}

for (const requiredFont of requiredFonts) {
  if (!existsSync(resolve(fontsRoot, requiredFont))) {
    failures.push(`Missing required webfont: ${requiredFont}`);
  }
}

const bundledFonts = readdirSync(fontsRoot).filter((file) => file.endsWith(".woff2"));
for (const bundledFont of bundledFonts) {
  if (!requiredFonts.includes(bundledFont)) {
    failures.push(`Unexpected bundled webfont: ${bundledFont}`);
  }
}

const tokenSource = readFileSync(resolve(stylesRoot, "tokens.css"), "utf8");
for (const token of requiredTokens) {
  if (!tokenSource.includes(`${token}:`)) {
    failures.push(`Missing required token: ${token}`);
  }
}

for (const requiredFont of requiredFonts) {
  if (!tokenSource.includes(requiredFont)) {
    failures.push(`tokens.css does not declare required webfont: ${requiredFont}`);
  }
}

if (!tokenSource.includes('font-family: "TX-02", ui-monospace, monospace;')) {
  failures.push("tokens.css must use TX-02 with local monospace fallbacks");
}

for (const file of files) {
  const source = readFileSync(resolve(stylesRoot, file), "utf8");

  if (file !== "tokens.css") {
    const rawColors = source.match(
      /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|lab|lch|oklab|oklch)\(/gi,
    );
    if (rawColors) {
      failures.push(`${file} contains raw colors: ${[...new Set(rawColors)].join(", ")}`);
    }
  }

  const forbiddenEffects = source.match(
    /\b(?:animation(?:-[\w-]+)?|transition(?:-[\w-]+)?|box-shadow|text-shadow|filter|backdrop-filter)\s*:/gi,
  );
  if (forbiddenEffects) {
    failures.push(
      `${file} contains prohibited effects: ${[...new Set(forbiddenEffects)].join(", ")}`,
    );
  }

  if (/\b(?:linear|radial|conic)-gradient\(/i.test(source)) {
    failures.push(`${file} contains a prohibited gradient`);
  }

  if (file !== "tokens.css") {
    for (const match of source.matchAll(/border-radius\s*:\s*([^;]+);/gi)) {
      if (!match[1].trim().startsWith("var(")) {
        failures.push(`${file} contains a border radius outside the token system`);
      }
    }
  }
}

const mainEntry = readFileSync(resolve(webRoot, "src/main.tsx"), "utf8");
const importPositions = requiredFiles.map((file) =>
  mainEntry.indexOf(`./styles/${file}`),
);
if (
  importPositions.some((position) => position === -1) ||
  importPositions.some((position, index) => index > 0 && position < importPositions[index - 1])
) {
  failures.push("main.tsx must import tokens.css, base.css, then app.css");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Design system checks passed for ${files.length} stylesheets.`);
