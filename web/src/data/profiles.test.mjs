import assert from "node:assert/strict";
import { test } from "node:test";

import "fake-indexeddb/auto";

import { openBrowserDatabase } from "./db.ts";
import {
  DEFAULT_NAMESPACE,
  activeProfile,
  createProfile,
  deleteProfile,
  listProfiles,
  normalizeProfileName,
  profileStorageNames,
  renameProfile,
  setActiveProfile,
} from "./profiles.ts";

/** The registry is process-wide, so each test claims its own library names. */
function uniqueName(label) {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

// Runs first, while the registry is still empty, to prove the adoption path.
test("the first read adopts the pre-profile library without renaming its storage", async () => {
  const profiles = await listProfiles();

  assert.equal(profiles.length, 1);
  const [adopted] = profiles;
  assert.equal(adopted.id, "default");
  assert.equal(
    adopted.namespace,
    DEFAULT_NAMESPACE,
    "an existing installation must keep using its original database",
  );
  assert.equal(profileStorageNames(adopted.namespace).database, "researchpocket-v2");
  assert.equal((await activeProfile()).id, adopted.id);
});

test("every profile owns a distinct database, lock, channel, and credential key", async () => {
  const [personal] = await listProfiles();
  const team = await createProfile(uniqueName("Team"));

  const one = profileStorageNames(personal.namespace);
  const two = profileStorageNames(team.namespace);

  const names = new Set([...Object.values(one), ...Object.values(two)]);
  assert.equal(
    names.size,
    Object.keys(one).length + Object.keys(two).length,
    "no durable name may be shared between two libraries",
  );
  assert.notEqual(one.sessionTokenKey, two.sessionTokenKey);
  assert.notEqual(one.syncLock, two.syncLock);
});

test("records written under one profile stay invisible to another", async () => {
  const first = await createProfile(uniqueName("Personal"));
  const second = await createProfile(uniqueName("Team"));

  const firstDb = await openBrowserDatabase(profileStorageNames(first.namespace).database);
  await firstDb.put("outbox", {
    path: "sync/v1/ops/device-a/00000000000000000001.json",
    enqueuedAt: "2026-07-24T00:00:00.000Z",
    attempts: 0,
    lastErrorKind: null,
  });
  firstDb.close();

  const secondDb = await openBrowserDatabase(profileStorageNames(second.namespace).database);
  assert.deepEqual(
    await secondDb.getAll("outbox"),
    [],
    "a queued update must not cross libraries",
  );
  assert.equal(await secondDb.get("meta", "library"), undefined);
  secondDb.close();
});

test("switching moves the active pointer and records when a library was opened", async () => {
  const [personal] = await listProfiles();
  const team = await createProfile(uniqueName("Team"));

  const switched = await setActiveProfile(team.id);
  assert.equal(switched.id, team.id);
  assert.ok(switched.lastOpenedAt, "an opened profile records when it was last used");
  assert.equal((await activeProfile()).id, team.id);

  await setActiveProfile(personal.id);
  assert.equal((await activeProfile()).id, personal.id);
});

test("names are normalized, required, and unique", async () => {
  const label = uniqueName("Reading");
  await createProfile(`  ${label}  `);
  assert.ok((await listProfiles()).some((profile) => profile.name === label));

  assert.equal(normalizeProfileName(" Reading  list "), "Reading list");
  assert.throws(() => normalizeProfileName("   "), /Enter a name/);
  await assert.rejects(createProfile(label.toLowerCase()), /already exists/);
  await assert.rejects(createProfile("x".repeat(61)), /limited to/);
});

test("renaming keeps identity and storage stable", async () => {
  const team = await createProfile(uniqueName("Team"));
  const label = uniqueName("Research");
  const renamed = await renameProfile(team.id, label);

  assert.equal(renamed.id, team.id);
  assert.equal(renamed.namespace, team.namespace);
  assert.equal(
    (await listProfiles()).find((profile) => profile.id === team.id).name,
    label,
  );
});

test("deleting a profile destroys its replica and reselects when it was open", async () => {
  const team = await createProfile(uniqueName("Team"));
  await setActiveProfile(team.id);

  const teamDb = await openBrowserDatabase(profileStorageNames(team.namespace).database);
  await teamDb.put("meta", {
    key: "library",
    libraryId: "00000000-0000-7000-8000-000000000009",
    deviceId: "00000000-0000-7000-8000-00000000000a",
    peerId: "7",
    nextSequence: "00000000000000000001",
    createdAt: "2026-07-24T00:00:00.000Z",
  });
  teamDb.close();

  const next = await deleteProfile(team.id);
  assert.notEqual(next.id, team.id, "deleting the open library selects another");
  assert.equal((await activeProfile()).id, next.id);
  assert.ok(!(await listProfiles()).some((profile) => profile.id === team.id));

  const reopened = await openBrowserDatabase(profileStorageNames(team.namespace).database);
  assert.equal(
    await reopened.get("meta", "library"),
    undefined,
    "the local replica is destroyed with the profile",
  );
  reopened.close();
});

// Runs last: it prunes the registry down to a single remaining library.
test("the last library cannot be deleted", async () => {
  const profiles = await listProfiles();
  for (const profile of profiles.slice(1)) {
    await deleteProfile(profile.id);
  }

  const remaining = await listProfiles();
  assert.equal(remaining.length, 1);
  await assert.rejects(deleteProfile(remaining[0].id), /at least one library/);
});
