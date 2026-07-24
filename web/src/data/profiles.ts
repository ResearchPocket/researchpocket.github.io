import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from "idb";

/**
 * A profile is one isolated local library container. Its identity is local
 * only: it never enters an update envelope, a repository path, or a receipt.
 * The canonical library identity still comes from the repository genesis.
 */
export interface LibraryProfile {
  id: string;
  name: string;
  namespace: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

/**
 * Every durable browser name a profile owns. Deriving them from one namespace
 * keeps a switch from leaving a store, lock, channel, or credential behind.
 */
export interface ProfileStorageNames {
  database: string;
  writeLock: string;
  stateChannel: string;
  syncLock: string;
  sessionTokenKey: string;
}

interface PersistedActiveProfile {
  key: "active";
  profileId: string;
}

interface ProfileRegistryDb extends DBSchema {
  profiles: {
    key: string;
    value: LibraryProfile;
  };
  registry: {
    key: "active";
    value: PersistedActiveProfile;
  };
}

const REGISTRY_DATABASE = "researchpocket-profiles";
const DEFAULT_PROFILE_ID = "default";
const DEFAULT_PROFILE_NAME = "Personal";
const MAX_NAME_LENGTH = 60;

/**
 * The first profile keeps the historical names, so an installation that
 * predates profiles adopts a default profile without moving any data.
 */
export const DEFAULT_NAMESPACE = "researchpocket-v2";

export function profileStorageNames(namespace: string): ProfileStorageNames {
  return {
    database: namespace,
    writeLock: `${namespace}-writer`,
    stateChannel: `${namespace}-state`,
    syncLock: `${namespace}-github-sync`,
    sessionTokenKey: `${namespace}-github-token`,
  };
}

let registryPromise: Promise<IDBPDatabase<ProfileRegistryDb>> | undefined;

function registryDatabase(): Promise<IDBPDatabase<ProfileRegistryDb>> {
  registryPromise ??= openDB<ProfileRegistryDb>(REGISTRY_DATABASE, 1, {
    upgrade(database) {
      database.createObjectStore("profiles", { keyPath: "id" });
      database.createObjectStore("registry", { keyPath: "key" });
    },
  });
  return registryPromise;
}

export function normalizeProfileName(name: string): string {
  const normalized = name.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("Enter a name for the library.");
  if (normalized.length > MAX_NAME_LENGTH) {
    throw new Error(`Library names are limited to ${MAX_NAME_LENGTH} characters.`);
  }
  return normalized;
}

function compareProfiles(left: LibraryProfile, right: LibraryProfile): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * Reads every profile, adopting the implicit pre-profile library as the
 * default entry the first time this runs.
 */
export async function listProfiles(): Promise<LibraryProfile[]> {
  const database = await registryDatabase();
  const profiles = await database.getAll("profiles");
  if (profiles.length > 0) return profiles.sort(compareProfiles);

  const adopted: LibraryProfile = {
    id: DEFAULT_PROFILE_ID,
    name: DEFAULT_PROFILE_NAME,
    namespace: DEFAULT_NAMESPACE,
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
  };
  const transaction = database.transaction(["profiles", "registry"], "readwrite");
  await transaction.objectStore("profiles").put(adopted);
  await transaction.objectStore("registry").put({ key: "active", profileId: adopted.id });
  await transaction.done;
  return [adopted];
}

export async function activeProfile(): Promise<LibraryProfile> {
  const profiles = await listProfiles();
  const database = await registryDatabase();
  const active = await database.get("registry", "active");
  const selected = profiles.find((profile) => profile.id === active?.profileId);
  if (selected) return selected;

  // The pointer names a profile that no longer exists; fall back to the oldest.
  const fallback = profiles[0]!;
  await database.put("registry", { key: "active", profileId: fallback.id });
  return fallback;
}

export async function setActiveProfile(profileId: string): Promise<LibraryProfile> {
  const database = await registryDatabase();
  const profile = await database.get("profiles", profileId);
  if (!profile) throw new Error("That library is no longer available.");

  const opened: LibraryProfile = { ...profile, lastOpenedAt: new Date().toISOString() };
  const transaction = database.transaction(["profiles", "registry"], "readwrite");
  await transaction.objectStore("profiles").put(opened);
  await transaction.objectStore("registry").put({ key: "active", profileId });
  await transaction.done;
  return opened;
}

export async function createProfile(name: string): Promise<LibraryProfile> {
  const normalized = normalizeProfileName(name);
  const profiles = await listProfiles();
  if (profiles.some((profile) => profile.name.toLowerCase() === normalized.toLowerCase())) {
    throw new Error("A library with that name already exists.");
  }

  const id = crypto.randomUUID();
  const profile: LibraryProfile = {
    id,
    name: normalized,
    namespace: `${DEFAULT_NAMESPACE}-${id}`,
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
  };
  const database = await registryDatabase();
  await database.put("profiles", profile);
  return profile;
}

export async function renameProfile(profileId: string, name: string): Promise<LibraryProfile> {
  const normalized = normalizeProfileName(name);
  const profiles = await listProfiles();
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error("That library is no longer available.");
  if (
    profiles.some(
      (candidate) =>
        candidate.id !== profileId &&
        candidate.name.toLowerCase() === normalized.toLowerCase(),
    )
  ) {
    throw new Error("A library with that name already exists.");
  }

  const renamed: LibraryProfile = { ...profile, name: normalized };
  const database = await registryDatabase();
  await database.put("profiles", renamed);
  return renamed;
}

/**
 * Removes a profile and destroys its local replica. The remote repository is
 * never touched, so a deleted local copy can be restored by reconnecting.
 */
export async function deleteProfile(profileId: string): Promise<LibraryProfile> {
  const profiles = await listProfiles();
  if (profiles.length === 1) {
    throw new Error("Keep at least one library.");
  }
  const profile = profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error("That library is no longer available.");

  const database = await registryDatabase();
  await database.delete("profiles", profileId);

  const active = await database.get("registry", "active");
  const remaining = profiles.filter((candidate) => candidate.id !== profileId);
  const next = remaining[0]!;
  if (active?.profileId === profileId) {
    await database.put("registry", { key: "active", profileId: next.id });
  }

  const names = profileStorageNames(profile.namespace);
  try {
    sessionStorage.removeItem(names.sessionTokenKey);
  } catch {
    // A blocked session store only means the token expires with the tab.
  }
  await deleteDB(names.database);

  return active?.profileId === profileId ? next : (await activeProfile());
}
