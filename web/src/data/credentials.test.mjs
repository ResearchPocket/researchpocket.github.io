import assert from "node:assert/strict";
import { test } from "node:test";
import "fake-indexeddb/auto";

import {
  forgetRememberedCredential,
  readCredential,
  rememberCredential,
} from "./credentials.ts";
import { createProfile, deleteProfile, profileStorageNames } from "./profiles.ts";

// One persistence-boundary scenario covers reopening, profile/repository identity,
// deletion, and the late-save race without duplicating it in UI unit tests.
test("remembered tokens survive reopen only for their library and cannot return after forgetting", async () => {
  const profile = await createProfile(`Remember ${crypto.randomUUID()}`);
  const other = await createProfile(`Other ${crypto.randomUUID()}`);
  const names = profileStorageNames(profile.namespace);
  const binding = { owner: "owner", repository: "private", branch: "main", libraryId: "library-a" };
  const token = "test-local-only-credential";

  assert.equal((await readCredential(names.credentialDatabase, binding)).token, null);
  assert.equal(await rememberCredential(names.credentialDatabase, binding, token, 0), true);
  // Each operation opens and closes the database, just as a new tab would.
  assert.equal((await readCredential(names.credentialDatabase, binding)).token, token);
  assert.equal((await readCredential(profileStorageNames(other.namespace).credentialDatabase, binding)).token, null);

  const { revision } = await readCredential(names.credentialDatabase, binding);
  await forgetRememberedCredential(names.credentialDatabase);
  assert.equal(await rememberCredential(names.credentialDatabase, binding, token, revision), false);
  assert.equal((await readCredential(names.credentialDatabase, binding)).token, null);

  for (const changed of [
    { ...binding, owner: "another-owner" },
    { ...binding, repository: "another-repo" },
    { ...binding, branch: "another-branch" },
    { ...binding, libraryId: "another-library" },
    null,
  ]) {
    const current = await readCredential(names.credentialDatabase, binding);
    assert.equal(await rememberCredential(names.credentialDatabase, binding, token, current.revision), true);
    assert.equal((await readCredential(names.credentialDatabase, changed)).token, null);
    assert.equal((await readCredential(names.credentialDatabase, binding)).token, null);
  }

  const current = await readCredential(names.credentialDatabase, binding);
  assert.equal(await rememberCredential(names.credentialDatabase, binding, token, current.revision), true);
  await deleteProfile(profile.id);
  assert.equal((await readCredential(names.credentialDatabase, binding)).token, null);
  assert.equal(await rememberCredential(names.credentialDatabase, binding, token, current.revision), false);
});
