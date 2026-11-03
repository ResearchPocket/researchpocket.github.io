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

/** Non-secret assistant choices; they never leave this browser profile. */
export interface AssistantSettings {
  version: 1;
  provider: string;
  model: string;
  /** Only for loopback presets; hosted presets have a fixed address. */
  localBaseUrl: string | null;
  /** The owner has seen where requests for this provider go. */
  disclosed: boolean;
}

export interface AssistantKeyBinding {
  provider: string;
  baseURL: string;
}

interface AssistantRecord {
  key: "assistant";
  revision: number;
  settings: AssistantSettings | null;
  saved: { version: 1; binding: AssistantKeyBinding; apiKey: string } | null;
}

/** Page capture choices; like the assistant's, they never leave this profile. */
export interface CaptureSettings {
  version: 1;
  /** Capture each page right after it is saved in this browser. */
  captureOnSave: boolean;
}

interface CaptureRecord {
  key: "firecrawl";
  revision: number;
  settings: CaptureSettings | null;
  saved: { version: 1; apiKey: string } | null;
}

interface CredentialDatabase extends DBSchema {
  credentials: { key: string; value: CredentialRecord | AssistantRecord | CaptureRecord };
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
    const record = (await tx.store.get("github")) as CredentialRecord | undefined;
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
    const record = (await tx.store.get("github")) as CredentialRecord | undefined;
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

/**
 * The assistant record shares this local-only database with the GitHub token
 * under its own key, so no schema version changes. A remembered key is bound
 * to the provider and address it was tested against.
 */
export async function readAssistant(name: string, resolveBinding: (settings: AssistantSettings) => AssistantKeyBinding | null) {
  const db = await database(name);
  try {
    const tx = db.transaction("credentials", "readwrite");
    const record = (await tx.store.get("assistant")) as AssistantRecord | undefined;
    const settings = record?.settings ?? null;
    const saved = record?.saved ?? null;
    const binding = settings ? resolveBinding(settings) : null;
    const matches = saved?.version === 1 && binding !== null &&
      saved.binding.provider === binding.provider &&
      saved.binding.baseURL === binding.baseURL;
    let revision = record?.revision ?? 0;
    if (record && saved && !matches) {
      revision += 1;
      await tx.store.put({ ...record, revision, saved: null });
    }
    await tx.done;
    return { revision, settings, apiKey: matches ? saved.apiKey : null };
  } finally {
    db.close();
  }
}

/**
 * Saves the settings, and the key only when the owner opted in. A forget in
 * another tab after `expectedRevision` was read wins over a late remember.
 */
export async function writeAssistant(
  name: string,
  settings: AssistantSettings,
  remember: { binding: AssistantKeyBinding; apiKey: string } | null,
  expectedRevision: number,
): Promise<{ revision: number; remembered: boolean }> {
  const db = await database(name);
  try {
    const tx = db.transaction("credentials", "readwrite");
    const record = (await tx.store.get("assistant")) as AssistantRecord | undefined;
    const current = record?.revision ?? 0;
    const remembered = remember !== null && current === expectedRevision;
    const revision = current + 1;
    await tx.store.put({
      key: "assistant",
      revision,
      settings,
      saved: remembered ? { version: 1, ...remember } : null,
    });
    await tx.done;
    return { revision, remembered };
  } finally {
    db.close();
  }
}

/** Forgets the saved key; `clearSettings` also turns the assistant off. */
export async function forgetAssistant(name: string, clearSettings: boolean): Promise<number> {
  const db = await database(name);
  try {
    const tx = db.transaction("credentials", "readwrite");
    const record = (await tx.store.get("assistant")) as AssistantRecord | undefined;
    const revision = (record?.revision ?? 0) + 1;
    await tx.store.put({
      key: "assistant",
      revision,
      settings: clearSettings ? null : record?.settings ?? null,
      saved: null,
    });
    await tx.done;
    return revision;
  } finally {
    db.close();
  }
}

/** The Firecrawl record shares the same local-only database under its own key. */
export async function readCapture(name: string) {
  const db = await database(name);
  try {
    const record = (await db.get("credentials", "firecrawl")) as CaptureRecord | undefined;
    const saved = record?.saved?.version === 1 ? record.saved : null;
    return {
      revision: record?.revision ?? 0,
      settings: record?.settings ?? null,
      apiKey: record?.settings ? saved?.apiKey ?? null : null,
    };
  } finally {
    db.close();
  }
}

/**
 * Saves the settings, and the key only when the owner opted in; `null`
 * settings turn page capture off and drop the key. A forget in another tab
 * after `expectedRevision` was read wins over a late remember.
 */
export async function writeCapture(
  name: string,
  settings: CaptureSettings | null,
  apiKey: string | null,
  expectedRevision: number,
): Promise<{ revision: number; remembered: boolean }> {
  const db = await database(name);
  try {
    const tx = db.transaction("credentials", "readwrite");
    const record = (await tx.store.get("firecrawl")) as CaptureRecord | undefined;
    const current = record?.revision ?? 0;
    const remembered = settings !== null && apiKey !== null && current === expectedRevision;
    const revision = current + 1;
    await tx.store.put({
      key: "firecrawl",
      revision,
      settings,
      saved: remembered ? { version: 1, apiKey } : null,
    });
    await tx.done;
    return { revision, remembered };
  } finally {
    db.close();
  }
}
