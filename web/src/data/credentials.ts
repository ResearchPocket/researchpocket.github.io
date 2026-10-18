import { openDB, type DBSchema } from "idb";

export interface CredentialBinding {
  owner: string;
  repository: string;
  branch: string;
  libraryId: string;
}

interface CredentialRecord {
  key: "github";
  revision: number;
  saved: { version: 1; binding: CredentialBinding; token: string } | null;
}

interface CredentialDatabase extends DBSchema {
  credentials: { key: string; value: CredentialRecord };
}

async function database(name: string) {
  return openDB<CredentialDatabase>(name, 1, {
    upgrade(db) {
      db.createObjectStore("credentials", { keyPath: "key" });
    },
  });
}

/** This database is local-only, never part of the library replica or exports. */
export async function readCredential(name: string, binding: CredentialBinding | null) {
  const db = await database(name);
  try {
    const tx = db.transaction("credentials", "readwrite");
    const record = await tx.store.get("github");
    const saved = record?.saved;
    const matches = saved?.version === 1 && binding !== null &&
      saved.binding.owner === binding.owner &&
      saved.binding.repository === binding.repository &&
      saved.binding.branch === binding.branch &&
      saved.binding.libraryId === binding.libraryId;
    if (saved && !matches) {
      await tx.store.put({ key: "github", revision: record.revision + 1, saved: null });
    }
    await tx.done;
    return {
      revision: (record?.revision ?? 0) + (saved && !matches ? 1 : 0),
      token: matches ? saved.token : null,
    };
  } finally {
    db.close();
  }
}

/** A forget in any tab invalidates saves that began before it. */
export async function rememberCredential(
  name: string,
  binding: CredentialBinding,
  token: string,
  expectedRevision: number,
): Promise<boolean> {
  const db = await database(name);
  try {
    const tx = db.transaction("credentials", "readwrite");
    const record = await tx.store.get("github");
    const matches = (record?.revision ?? 0) === expectedRevision;
    if (matches) {
      await tx.store.put({
        key: "github",
        revision: expectedRevision + 1,
        saved: { version: 1, binding, token },
      });
    }
    await tx.done;
    return matches;
  } finally {
    db.close();
  }
}

export async function forgetRememberedCredential(name: string): Promise<number> {
  const db = await database(name);
  try {
    const tx = db.transaction("credentials", "readwrite");
    const record = await tx.store.get("github");
    // Keep a non-secret generation so an in-flight validation cannot re-save it.
    const revision = (record?.revision ?? 0) + 1;
    await tx.store.put({ key: "github", revision, saved: null });
    await tx.done;
    return revision;
  } finally {
    db.close();
  }
}
