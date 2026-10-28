import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractZenLinks,
  insertZenLink,
  linkCompletion,
  parseZenLink,
} from "./zenLinks.ts";

const id = "01900000-0000-7000-8000-000000000001";
const other = "01900000-0000-7000-8000-000000000002";

test("backlinks count rendered Markdown references, deduplicate, and reject code, images and malformed destinations", () => {
  const body = `[live](research:zen/${id})\n[again][ref]\n\n[ref]: research:zen/${id}\n\n<research:item/${other}>\n\n`;
  assert.deepEqual(extractZenLinks(body), [`zen:${id}`, `item:${other}`]);
  assert.deepEqual(
    extractZenLinks(
      [
        `\`[example](research:zen/${id})\``,
        `\n\`\`\`md\n[example](research:item/${other})\n\`\`\``,
        `![image](research:zen/${id})`,
        `research:zen/${id}`,
        `[bad](research:zen/${id}suffix)`,
        `[wrong](research:unknown/${id})`,
      ].join("\n"),
    ),
    [],
  );
  assert.equal(parseZenLink(`research:zen/${id}?secret=1`), null);
});

test("completion replaces only the selected trigger and keeps hostile titles as literal link text", () => {
  const body = "Before [[read]] after 😀";
  const range = linkCompletion(body, 13);
  assert.deepEqual(range, { start: 7, end: 15, query: "read" });
  const target = {
    kind: "zen",
    id,
    title: "A [link](https://elsewhere)\nwith *markup*",
    detail: "Zen",
  };
  const result = insertZenLink(body, range.start, range.end, target);
  assert.deepEqual(extractZenLinks(result.body), [`zen:${id}`]);
  assert.ok(
    result.body.startsWith(
      "Before [A \\[link\\]\\(https://elsewhere\\) with \\*markup\\*](research:zen/",
    ),
  );
  assert.equal(result.body.slice(result.caret), " after 😀");
  assert.equal(linkCompletion("closed [[read]]", 15), null);
  assert.equal(linkCompletion("[[line\nbreak", 12), null);
  assert.equal(linkCompletion("[[selected", 5, 8), null);
});
