import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGraphProjection,
  constellationProjection,
  extractMentions,
  itemNodeId,
  tagNodeId,
} from "./graph.ts";

function item(id, tags, overrides = {}) {
  return {
    id,
    url: `https://example.com/${id}`,
    title: `Item ${id}`,
    tags,
    favorite: false,
    savedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

const ids = Array.from(
  { length: 30 },
  (_, index) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
);

test("tags become hubs rather than an item-to-item clique", () => {
  const projection = buildGraphProjection([
    item(ids[0], ["crdt"]),
    item(ids[1], ["crdt"]),
    item(ids[2], ["crdt"]),
  ]);

  // Three items sharing a tag is three edges through one hub, not the three
  // item-to-item edges a clique would draw. The distinction is the whole
  // reason tag nodes exist: a 300-item tag would otherwise be ~45k edges.
  assert.equal(projection.edges.length, 3);
  assert.ok(projection.edges.every((edge) => edge.kind === "tag"));
  assert.ok(projection.edges.every((edge) => edge.target === tagNodeId("crdt")));
  assert.equal(
    projection.nodes.find((node) => node.id === tagNodeId("crdt")).count,
    3,
  );
  assert.deepEqual(projection.orphans, []);
});

test("co-mentions pair the items a document names and count the documents", () => {
  const projection = buildGraphProjection(
    [item(ids[0], []), item(ids[1], []), item(ids[2], [])],
    [
      { documentId: "doc-a", itemIds: [ids[0], ids[1], ids[2]] },
      { documentId: "doc-b", itemIds: [ids[0], ids[1]] },
      // A mention of an item outside the result set is not an edge to
      // something the graph is not showing.
      { documentId: "doc-c", itemIds: [ids[0], ids[9]] },
    ],
  );

  assert.equal(projection.edges.length, 3);
  assert.ok(projection.edges.every((edge) => edge.kind === "mention"));
  const repeated = projection.edges.find(
    (edge) =>
      edge.source === itemNodeId(ids[0]) && edge.target === itemNodeId(ids[1]),
  );
  assert.equal(repeated.weight, 2);
});

test("a link-dump document cannot dominate the layout", () => {
  const members = ids.slice(0, 30);
  const projection = buildGraphProjection(
    members.map((id) => item(id, [])),
    [{ documentId: "dump", itemIds: members }],
    { maxComentionFanout: 5 },
  );

  // Capped at five mentions, so ten pairs — not the 435 the full document
  // would have contributed.
  assert.equal(projection.edges.length, 10);
  assert.equal(projection.orphans.length, 25);
});

test("an item with no tag and no mention is reported as an orphan", () => {
  const projection = buildGraphProjection(
    [item(ids[0], ["crdt"]), item(ids[1], []), item(ids[2], [])],
    [{ documentId: "doc-a", itemIds: [ids[0], ids[2]] }],
  );

  assert.deepEqual(projection.orphans, [itemNodeId(ids[1])]);
  assert.equal(
    projection.nodes.find((node) => node.id === itemNodeId(ids[0])).degree,
    2,
  );
});

test("the node set is the result set, and switching edge kinds never changes it", () => {
  const items = [item(ids[0], ["crdt"]), item(ids[1], ["rust"])];
  const mentions = [{ documentId: "doc-a", itemIds: [ids[0], ids[1]] }];
  const itemNodes = (projection) =>
    projection.nodes.filter((node) => node.kind === "item").map((node) => node.id);

  const full = buildGraphProjection(items, mentions);
  const withoutTags = buildGraphProjection(items, mentions, { tagEdges: false });
  const withoutMentions = buildGraphProjection(items, mentions, {
    mentionEdges: false,
  });

  assert.deepEqual(itemNodes(full), itemNodes(withoutTags));
  assert.deepEqual(itemNodes(full), itemNodes(withoutMentions));
  // Tag hubs are drawn only when their edges are, or they stand unreachable.
  assert.ok(!withoutTags.nodes.some((node) => node.kind === "tag"));
  assert.deepEqual(withoutMentions.orphans, []);
});

test("the mobile constellation keeps the busiest tags and their saves", () => {
  const projection = buildGraphProjection([
    item(ids[0], ["crdt"]),
    item(ids[1], ["crdt"]),
    item(ids[2], ["rust"]),
    item(ids[3], []),
  ]);

  const constellation = constellationProjection(projection, 1);
  assert.deepEqual(
    constellation.nodes.map((node) => node.id).sort(),
    [itemNodeId(ids[0]), itemNodeId(ids[1]), tagNodeId("crdt")].sort(),
  );
  assert.deepEqual(constellation.orphans, []);
});

test("mentions are read out of a body the way the reader resolves them", () => {
  const body = [
    `A [save](research:item/${ids[0]}) and the [same one](research:item/${ids[0]}).`,
    `An autolink <research:item/${ids[1]}> counts too.`,
    "A plain link (https://example.com) and research:item/not-a-uuid do not.",
  ].join("\n");

  assert.deepEqual(extractMentions(body), [ids[0], ids[1]]);
  assert.deepEqual(extractMentions("nothing here"), []);
});
