import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeMarkdownMathDelimiters,
  splitBareMathText,
} from "./markdownMath.ts";

test("alternate TeX delimiters become Markdown math outside code", () => {
  const source = [
    String.raw`Inline \(\x_1 + \x_2\) and escaped \\(\x_3\\).`,
    "Code: `\\\\(\\x_4\\\\)`.",
    "```tex",
    String.raw`\[\x_5\]`,
    "```",
    String.raw`\[\sum_i \x_i\]`,
  ].join("\n");

  assert.equal(
    normalizeMarkdownMathDelimiters(source),
    [
      String.raw`Inline $\x_1 + \x_2$ and escaped $\x_3$.`,
      "Code: `\\\\(\\x_4\\\\)`.",
      "```tex",
      String.raw`\[\x_5\]`,
      "```",
      String.raw`$$\sum_i \x_i$$`,
    ].join("\n"),
  );
});

test("escaped Firecrawl vector sequences become one inline expression", () => {
  const nodes = splitBareMathText(
    String.raw`Inputs \x_1, \x_2, \ldots, \x_t and outputs \y_1.`,
  );
  assert.deepEqual(
    nodes.map(({ type, value }) => ({ type, value })),
    [
      { type: "text", value: "Inputs " },
      {
        type: "inlineMath",
        value: String.raw`\x_1, \x_2, \ldots, \x_t`,
      },
      { type: "text", value: " and outputs " },
      { type: "inlineMath", value: String.raw`\y_1` },
      { type: "text", value: "." },
    ],
  );
});

test("ordinary backslashes and standalone standard commands remain text", () => {
  assert.deepEqual(splitBareMathText(String.raw`C:\Users\ori and \ldots`), [
    { type: "text", value: String.raw`C:\Users\ori and \ldots` },
  ]);
});
