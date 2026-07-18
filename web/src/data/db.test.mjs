import assert from "node:assert/strict";
import { test } from "node:test";

import "fake-indexeddb/auto";
import { deleteDB } from "idb";

import { openBrowserDatabase } from "./db.ts";

test("a browser library commit survives reopen and an interrupted replacement rolls back", async () => {
  const databaseName = `researchpocket-contract-${crypto.randomUUID()}`;
  let database = await openBrowserDatabase(databaseName);

  const meta = {
    key: "library",
    libraryId: "00000000-0000-7000-8000-000000000001",
    deviceId: "00000000-0000-7000-8000-000000000002",
    peerId: "42",
    nextSequence: "00000000000000000002",
    createdAt: "2026-07-11T00:00:00.000Z",
  };
  const snapshot = {
    key: "canonical",
    snapshot: "exact-snapshot",
    updatedAt: "2026-07-11T00:00:01.000Z",
  };
  const item = {
    id: "00000000-0000-7000-8000-000000000003",
    url: "https://example.com",
    title: "Kept context",
    excerpt: null,
    note: "Why it mattered",
    favorite: true,
    language: null,
    savedAt: "2026-07-11T00:00:00.000Z",
    savedAtUnix: 1_783_728_000,
    tags: ["reference"],
    deleted: false,
  };
  const path = `sync/v1/ops/${meta.deviceId}/00000000000000000001.json`;
  const batch = {
    path,
    libraryId: meta.libraryId,
    deviceId: meta.deviceId,
    sequence: "00000000000000000001",
    payloadSha256: "a".repeat(64),
    envelopeJson: "{\"exact\":true}",
    origin: "local",
    appliedAt: "2026-07-11T00:00:01.000Z",
  };
  const outbox = {
    path,
    enqueuedAt: "2026-07-11T00:00:01.000Z",
    attempts: 0,
    lastErrorKind: null,
    summary: {
      version: 1,
      kind: "create",
      itemId: item.id,
      fields: ["url", "title", "note"],
      favorite: true,
      addedTags: ["reference"],
      removedTags: [],
    },
  };
  const syncConfig = {
    key: "github",
    owner: "owner",
    repository: "private-library",
    branch: "main",
    connectedAt: "2026-07-11T00:00:02.000Z",
    lastSuccessAt: null,
    lastErrorKind: null,
    lastErrorAt: null,
  };

  const commit = database.transaction(
    ["meta", "state", "items", "batches", "outbox", "syncConfig"],
    "readwrite",
  );
  await commit.objectStore("meta").add(meta);
  await commit.objectStore("state").add(snapshot);
  await commit.objectStore("items").add(item);
  await commit.objectStore("batches").add(batch);
  await commit.objectStore("outbox").add(outbox);
  await commit.objectStore("syncConfig").add(syncConfig);
  await commit.done;

  database.close();
  database = await openBrowserDatabase(databaseName);
  assert.deepEqual(await database.get("meta", "library"), meta);
  assert.deepEqual(await database.get("state", "canonical"), snapshot);
  assert.deepEqual(await database.get("items", item.id), item);
  assert.deepEqual(await database.get("batches", path), batch);
  assert.deepEqual(await database.get("outbox", path), outbox);
  assert.deepEqual(await database.get("syncConfig", "github"), syncConfig);
  assert.equal(JSON.stringify(syncConfig).includes("token"), false);

  const interrupted = database.transaction(
    ["meta", "state", "items", "outbox", "syncConfig"],
    "readwrite",
  );
  void interrupted.objectStore("meta").put({
    ...meta,
    nextSequence: "00000000000000000003",
  }).catch(() => undefined);
  void interrupted.objectStore("state").put({
    ...snapshot,
    snapshot: "partial-new-snapshot",
  }).catch(() => undefined);
  void interrupted.objectStore("items").clear().catch(() => undefined);
  void interrupted.objectStore("outbox").delete(path).catch(() => undefined);
  void interrupted.objectStore("syncConfig").put({
    ...syncConfig,
    lastErrorKind: "transport",
  }).catch(() => undefined);
  interrupted.abort();
  await assert.rejects(interrupted.done);

  database.close();
  database = await openBrowserDatabase(databaseName);
  assert.deepEqual(await database.get("meta", "library"), meta);
  assert.deepEqual(await database.get("state", "canonical"), snapshot);
  assert.deepEqual(await database.get("items", item.id), item);
  assert.deepEqual(await database.get("outbox", path), outbox);
  assert.deepEqual(await database.get("syncConfig", "github"), syncConfig);

  database.close();
  await deleteDB(databaseName);
});
