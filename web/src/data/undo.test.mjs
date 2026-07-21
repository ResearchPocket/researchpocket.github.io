import assert from "node:assert/strict";
import { test } from "node:test";

import { createUndoableChange, matchesUndoExpectation } from "./undo.ts";

const original = {
  id: "00000000-0000-7000-8000-000000000003",
  url: "https://example.com/original",
  title: "Original",
  excerpt: "Old context",
  note: "Old note",
  favorite: false,
  language: "en",
  savedAt: "2026-07-21T00:00:00.000Z",
  savedAtUnix: 1_784_592_000,
  tags: ["keep", "read"],
  deleted: false,
};

test("undo builds compensating mutations for item lifecycle changes", () => {
  const created = createUndoableChange("create", undefined, original);
  assert.deepEqual(created.mutation, { type: "delete", item_id: original.id });

  const deletedItem = { ...original, deleted: true };
  const deleted = createUndoableChange("delete", original, deletedItem);
  assert.deepEqual(deleted.mutation, { type: "restore", item_id: original.id });

  const restored = createUndoableChange("restore", deletedItem, original);
  assert.deepEqual(restored.mutation, { type: "delete", item_id: original.id });
});

test("undo restores edited fields and refuses a stale item projection", () => {
  const edited = {
    ...original,
    url: "https://example.com/edited",
    title: null,
    excerpt: "New context",
    note: "New note",
    favorite: true,
    language: null,
    tags: ["new"],
  };
  const undo = createUndoableChange("edit", original, edited);

  assert.deepEqual(undo.mutation, {
    type: "edit",
    item_id: original.id,
    url: original.url,
    title: { type: "set", value: "Original" },
    excerpt: { type: "set", value: "Old context" },
    note: { type: "set", value: "Old note" },
    expected_note: "New note",
    favorite: false,
    language: { type: "set", value: "en" },
  });
  assert.deepEqual(undo.targetTags, ["keep", "read"]);
  assert.equal(matchesUndoExpectation(edited, undo.expectedItem), true);
  assert.equal(
    matchesUndoExpectation({ ...edited, favorite: false }, undo.expectedItem),
    false,
  );
  assert.equal(matchesUndoExpectation(undefined, undo.expectedItem), false);
});
