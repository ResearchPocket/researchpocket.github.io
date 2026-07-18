import initWasm, {
  applyMutation,
  applyRemoteEnvelopes,
  initializeLibrary,
  materializeLibrary,
} from "../generated/research_domain";

import {
  browserDatabase,
  type BrowserDatabase,
  type PersistedBatch,
  type PersistedChangeField,
  type PersistedChangeKind,
  type PersistedChangeSummary,
  type PersistedDeferred,
  type PersistedItem,
  type PersistedLibraryMeta,
  type PersistedOutbox,
  type PersistedSnapshot,
  type PersistedSyncConfiguration,
  type RemoteObservation,
} from "./db";

export type LibraryItem = PersistedItem;

export interface LibraryState {
  initialized: boolean;
  loading: boolean;
  items: LibraryItem[];
  pendingChanges: PendingSyncChange[];
  pendingCount: number;
  status: string;
  error: string | null;
}

export interface PendingSyncChange {
  path: string;
  enqueuedAt: string;
  attempts: number;
  lastErrorKind: string | null;
  kind: PersistedChangeKind | "queued";
  itemId: string | null;
  label: string;
  fields: PersistedChangeField[];
  favorite: boolean | null;
  addedTags: string[];
  removedTags: string[];
}

export interface AddItemInput {
  url: string;
  title?: string | null;
  excerpt?: string | null;
  note?: string | null;
  favorite?: boolean;
  language?: string | null;
  tags?: string[];
}

export interface EditItemInput {
  url?: string;
  title?: string | null;
  excerpt?: string | null;
  note?: string | null;
  favorite?: boolean;
  language?: string | null;
  tags?: string[];
  expectedNote?: string | null;
}

export interface RemoteEnvelopeInput {
  path: string;
  blobSha: string;
  envelopeJson: string;
}

export interface RemoteOperationPackInput {
  path: string;
  blobSha: string;
  memberEnvelopes: string[];
}

export type SyncConfiguration = PersistedSyncConfiguration;

export interface PendingSyncBatch {
  path: string;
  envelopeJson: string;
  attempts: number;
}

export interface BrowserSyncIdentity {
  libraryId: string;
  deviceId: string;
  createdAt: string;
}

interface RawProjection {
  schema_version: number;
  items: Array<{
    id: string;
    url: string;
    title: string | null;
    excerpt: string | null;
    note: string | null;
    favorite: boolean;
    language: string | null;
    saved_at: number;
    tags: string[];
    state: "active" | "deleted";
  }>;
}

interface MutationResult {
  snapshot: string;
  projection: RawProjection;
  envelope: string;
}

interface RemoteApplyResult {
  snapshot: string;
  projection: RawProjection;
  pending_indices: number[];
}

interface EnvelopeIdentity {
  library_id: string;
  device_id: string;
  sequence: string;
  payload_sha256: string;
}

interface ValidatedRemoteMember {
  path: string;
  envelopeJson: string;
  identity: EnvelopeIdentity;
}

interface ValidatedRemoteArtifact {
  path: string;
  blobSha: string;
  members: ValidatedRemoteMember[];
}

type TextUpdate =
  | { type: "set"; value: string }
  | { type: "clear" };

const WRITE_LOCK = "researchpocket-v2-writer";
const CHANNEL_NAME = "researchpocket-v2-state";
const U64_MAX = 18_446_744_073_709_551_615n;

let wasmPromise: Promise<unknown> | undefined;

function ensureWasm(): Promise<unknown> {
  wasmPromise ??= initWasm();
  return wasmPromise;
}

class LibraryRepository {
  private state: LibraryState = {
    initialized: false,
    loading: true,
    items: [],
    pendingChanges: [],
    pendingCount: 0,
    status: "Opening your private library…",
    error: null,
  };

  private readonly listeners = new Set<(state: LibraryState) => void>();
  private readonly channel = new BroadcastChannel(CHANNEL_NAME);

  constructor() {
    this.channel.addEventListener("message", () => {
      void this.load();
    });
    window.addEventListener("researchpocket:database-blocked", () => {
      this.patchState({
        error: "Another tab is finishing a library upgrade. Close older tabs and retry.",
        status: "Library upgrade blocked",
      });
    });
    void this.load();
  }

  getState(): LibraryState {
    return this.state;
  }

  subscribe(listener: (state: LibraryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async initialize(): Promise<void> {
    await this.write(async (database) => {
      const existing = await database.get("meta", "library");
      if (existing) {
        return;
      }
      this.patchState({ loading: true, status: "Creating your offline library…", error: null });
      await ensureWasm();
      const now = new Date().toISOString();
      const meta: PersistedLibraryMeta = {
        key: "library",
        libraryId: uuidV7(),
        deviceId: uuidV7(),
        peerId: randomPeerId(),
        nextSequence: "00000000000000000001",
        createdAt: now,
      };
      const snapshot = initializeLibrary(meta.peerId);
      const projection = parseProjection(materializeLibrary(snapshot, meta.peerId));
      const items = materializeProjection(projection);
      const transaction = database.transaction(["meta", "state", "items"], "readwrite");
      try {
        await transaction.objectStore("meta").add(meta);
        await transaction.objectStore("state").put({
          key: "canonical",
          snapshot,
          updatedAt: now,
        });
        await replaceItems(transaction.objectStore("items"), items);
        await transaction.done;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
    await this.afterCommit("Offline library ready");
  }

  async add(input: AddItemInput): Promise<void> {
    const itemId = uuidV7();
    await this.commitMutation({
      type: "create",
      item_id: itemId,
      url: input.url,
      title: input.title ?? null,
      excerpt: input.excerpt ?? null,
      favorite: input.favorite ?? false,
      language: input.language ?? null,
      saved_at: Math.floor(Date.now() / 1_000),
      note: input.note ?? null,
      tags: exactTags(input.tags ?? []),
    });
  }

  async edit(itemId: string, input: EditItemInput): Promise<void> {
    const mutation: Record<string, unknown> = { type: "edit", item_id: itemId };
    if (input.url !== undefined) mutation.url = input.url;
    if (input.title !== undefined) mutation.title = textUpdate(input.title);
    if (input.excerpt !== undefined) mutation.excerpt = textUpdate(input.excerpt);
    if (input.note !== undefined) {
      mutation.note = textUpdate(input.note);
      if (input.expectedNote !== undefined) mutation.expected_note = input.expectedNote;
    }
    if (input.favorite !== undefined) mutation.favorite = input.favorite;
    if (input.language !== undefined) mutation.language = textUpdate(input.language);
    await this.commitMutation(
      mutation,
      input.tags === undefined ? undefined : exactTags(input.tags),
    );
  }

  async remove(itemId: string): Promise<void> {
    await this.commitMutation({ type: "delete", item_id: itemId });
  }

  async restore(itemId: string): Promise<void> {
    await this.commitMutation({ type: "restore", item_id: itemId });
  }

  async syncIdentity(): Promise<BrowserSyncIdentity> {
    const database = await browserDatabase();
    const meta = await database.get("meta", "library");
    if (!meta) throw new Error("Create the browser library before connecting sync.");
    return {
      libraryId: meta.libraryId,
      deviceId: meta.deviceId,
      createdAt: meta.createdAt,
    };
  }

  async syncConfiguration(): Promise<SyncConfiguration | null> {
    return (await (await browserDatabase()).get("syncConfig", "github")) ?? null;
  }

  async configureSync(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<SyncConfiguration> {
    let configured: SyncConfiguration | undefined;
    await this.write(async (database) => {
      const existing = await database.get("syncConfig", "github");
      if (
        existing &&
        (existing.owner !== owner ||
          existing.repository !== repository ||
          existing.branch !== branch)
      ) {
        throw new Error(
          "This browser library is already connected to another synchronization repository.",
        );
      }
      configured =
        existing ??
        {
          key: "github",
          owner,
          repository,
          branch,
          connectedAt: new Date().toISOString(),
          lastSuccessAt: null,
          lastErrorKind: null,
          lastErrorAt: null,
        };
      await database.put("syncConfig", configured);
    });
    if (!configured) throw new Error("The synchronization configuration was not saved.");
    return configured;
  }

  async adoptRemoteLibraryIfPristine(libraryId: string): Promise<boolean> {
    let adopted = false;
    await this.write(async (database) => {
      const transaction = database.transaction(
        ["meta", "items", "batches", "outbox", "deferred", "remoteObservations"],
        "readwrite",
      );
      try {
        const metaStore = transaction.objectStore("meta");
        const meta = await metaStore.get("library");
        if (!meta) throw new Error("The browser library is not initialized.");
        if (meta.libraryId === libraryId) {
          await transaction.done;
          return;
        }
        const counts = await Promise.all([
          transaction.objectStore("items").count(),
          transaction.objectStore("batches").count(),
          transaction.objectStore("outbox").count(),
          transaction.objectStore("deferred").count(),
          transaction.objectStore("remoteObservations").count(),
        ]);
        if (
          meta.nextSequence !== "00000000000000000001" ||
          counts.some((count) => count !== 0)
        ) {
          throw new Error(
            "This browser already contains a different library. Open a fresh browser profile or clear this site's local library before restoring another one.",
          );
        }
        await metaStore.put({ ...meta, libraryId });
        await transaction.done;
        adopted = true;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
    if (adopted) this.channel.postMessage({ type: "changed" });
    return adopted;
  }

  async pendingSyncBatches(): Promise<PendingSyncBatch[]> {
    const database = await browserDatabase();
    const outbox = await database.getAll("outbox");
    const pending = await Promise.all(
      outbox.map(async (entry) => {
        const batch = await database.get("batches", entry.path);
        if (!batch) {
          throw new Error("A queued synchronization update is missing its immutable batch.");
        }
        return {
          path: entry.path,
          envelopeJson: batch.envelopeJson,
          attempts: entry.attempts,
        };
      }),
    );
    return pending.sort((left, right) => left.path.localeCompare(right.path));
  }

  async remoteObservation(path: string): Promise<RemoteObservation | null> {
    return (await (await browserDatabase()).get("remoteObservations", path)) ?? null;
  }

  async recordRemoteObservation(path: string, blobSha: string): Promise<void> {
    validateBlobSha(blobSha);
    await this.write(async (database) => {
      const existing = await database.get("remoteObservations", path);
      if (existing && existing.blobSha !== blobSha) {
        throw new Error("An immutable remote path changed its Git object identity.");
      }
      await database.put("remoteObservations", {
        path,
        blobSha,
        observedAt: new Date().toISOString(),
      });
    });
  }

  async recordOutboxAttempt(path: string, errorKind: string | null): Promise<void> {
    await this.recordOutboxAttempts([path], errorKind);
  }

  async recordOutboxAttempts(paths: string[], errorKind: string | null): Promise<void> {
    const uniquePaths = [...new Set(paths)];
    if (uniquePaths.length === 0) return;
    await this.write(async (database) => {
      const transaction = database.transaction("outbox", "readwrite");
      try {
        const outbox = transaction.objectStore("outbox");
        for (const path of uniquePaths) {
          const entry = await outbox.get(path);
          if (!entry) continue;
          await outbox.put({
            ...entry,
            attempts: entry.attempts + 1,
            lastErrorKind: errorKind,
          });
        }
        await transaction.done;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
  }

  async deferredSyncCount(): Promise<number> {
    return (await browserDatabase()).count("deferred");
  }

  async recordSyncSuccess(): Promise<void> {
    await this.recordSyncResult(null);
  }

  async recordSyncFailure(kind: string): Promise<void> {
    await this.recordSyncResult(kind);
  }

  async applyRemote(
    inputs: RemoteEnvelopeInput[],
    packs: RemoteOperationPackInput[] = [],
  ): Promise<number> {
    if (inputs.length === 0 && packs.length === 0) return 0;
    let applied = 0;
    await this.write(async (database) => {
      const persisted = await readPersisted(database);
      const artifacts = validateRemoteArtifacts(inputs, packs, persisted.meta.libraryId);
      const newMembers: ValidatedRemoteMember[] = [];
      const newMemberPaths = new Set<string>();
      for (const artifact of artifacts) {
        const observation = await database.get("remoteObservations", artifact.path);
        if (observation && observation.blobSha !== artifact.blobSha) {
          throw new Error("An immutable remote path changed its Git object identity.");
        }
        for (const member of artifact.members) {
          const existing = await database.get("batches", member.path);
          if (existing && existing.envelopeJson !== member.envelopeJson) {
            throw new Error("An immutable remote update changed after it was observed.");
          }
          if (!existing && !newMemberPaths.has(member.path)) {
            newMembers.push(member);
            newMemberPaths.add(member.path);
          }
        }
      }
      applied = newMembers.length;
      const deferred = await database.getAll("deferred");
      const combined = [
        ...newMembers.map((member) => ({
          path: member.path,
          blobSha: "",
          envelopeJson: member.envelopeJson,
        })),
        ...deferred.map((entry) => ({
          path: entry.path,
          blobSha: "",
          envelopeJson: entry.envelopeJson,
        })),
      ];
      await ensureWasm();
      const result = JSON.parse(
        applyRemoteEnvelopes(
          persisted.snapshot.snapshot,
          persisted.meta.peerId,
          persisted.meta.libraryId,
          JSON.stringify(combined.map((entry) => entry.envelopeJson)),
        ),
      ) as RemoteApplyResult;
      const now = new Date().toISOString();
      const items = materializeProjection(result.projection);
      const pendingRecords = materializeDeferred(result.pending_indices, combined);
      const newBatchRecords = newMembers.map((member) =>
        batchRecord(
          member.path,
          member.envelopeJson,
          member.identity,
          "remote",
          now,
        ),
      );
      const transaction = database.transaction(
        ["state", "items", "batches", "outbox", "deferred", "remoteObservations"],
        "readwrite",
      );
      try {
        await transaction.objectStore("state").put({
          key: "canonical",
          snapshot: result.snapshot,
          updatedAt: now,
        });
        await replaceItems(transaction.objectStore("items"), items);
        await transaction.objectStore("deferred").clear();
        for (const record of pendingRecords) {
          await transaction.objectStore("deferred").put(record);
        }
        for (const record of newBatchRecords) {
          await transaction.objectStore("batches").add(record);
        }
        for (const artifact of artifacts) {
          for (const member of artifact.members) {
            await transaction.objectStore("outbox").delete(member.path);
          }
          await transaction.objectStore("remoteObservations").put({
            path: artifact.path,
            blobSha: artifact.blobSha,
            observedAt: now,
          });
        }
        await transaction.done;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
    await this.afterCommit("Remote changes applied");
    return applied;
  }

  private async commitMutation(
    mutation: Record<string, unknown>,
    targetTags?: string[],
  ): Promise<void> {
    let committed = false;
    await this.write(async (database) => {
      const persisted = await readPersisted(database);
      const itemId = mutationItemId(mutation);
      const beforeItem = await database.get("items", itemId);
      const normalizedMutation = normalizeMutation(mutation, beforeItem, targetTags);
      if (!normalizedMutation) return;
      await ensureWasm();
      const now = new Date().toISOString();
      const result = JSON.parse(
        applyMutation(
          persisted.snapshot.snapshot,
          persisted.meta.peerId,
          persisted.meta.libraryId,
          persisted.meta.deviceId,
          persisted.meta.nextSequence,
          now,
          JSON.stringify(normalizedMutation),
        ),
      ) as MutationResult;
      const identity = parseEnvelope(result.envelope);
      if (
        identity.library_id !== persisted.meta.libraryId ||
        identity.device_id !== persisted.meta.deviceId ||
        identity.sequence !== persisted.meta.nextSequence
      ) {
        throw new Error("The domain core returned a mutation with the wrong identity.");
      }
      const path = operationPath(identity.device_id, identity.sequence);
      const nextMeta: PersistedLibraryMeta = {
        ...persisted.meta,
        nextSequence: incrementSequence(persisted.meta.nextSequence),
      };
      const items = materializeProjection(result.projection);
      const afterItem = items.find((item) => item.id === itemId);
      const summary = summarizeMutation(normalizedMutation, beforeItem, afterItem);
      const batch = batchRecord(path, result.envelope, identity, "local", now);
      const outbox: PersistedOutbox = {
        path,
        enqueuedAt: now,
        attempts: 0,
        lastErrorKind: null,
        summary,
      };
      const transaction = database.transaction(
        ["meta", "state", "items", "batches", "outbox"],
        "readwrite",
      );
      try {
        await transaction.objectStore("meta").put(nextMeta);
        await transaction.objectStore("state").put({
          key: "canonical",
          snapshot: result.snapshot,
          updatedAt: now,
        });
        await replaceItems(transaction.objectStore("items"), items);
        await transaction.objectStore("batches").add(batch);
        await transaction.objectStore("outbox").add(outbox);
        await transaction.done;
        committed = true;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
    if (committed) {
      await this.afterCommit("Saved offline — queued for synchronization");
    }
  }

  private async recordSyncResult(errorKind: string | null): Promise<void> {
    await this.write(async (database) => {
      const configuration = await database.get("syncConfig", "github");
      if (!configuration) return;
      const now = new Date().toISOString();
      await database.put("syncConfig", {
        ...configuration,
        lastSuccessAt: errorKind === null ? now : configuration.lastSuccessAt,
        lastErrorKind: errorKind,
        lastErrorAt: errorKind === null ? null : now,
      });
    });
  }

  private async load(): Promise<void> {
    try {
      const database = await browserDatabase();
      const meta = await database.get("meta", "library");
      if (!meta) {
        this.state = {
          initialized: false,
          loading: false,
          items: [],
          pendingChanges: [],
          pendingCount: 0,
          status: "Create an offline library to begin",
          error: null,
        };
        this.emit();
        return;
      }
      const [items, outbox] = await Promise.all([
        database.getAll("items"),
        database.getAll("outbox"),
      ]);
      items.sort(compareItems);
      const pendingChanges = materializePendingChanges(outbox, items);
      const pendingCount = pendingChanges.length;
      this.state = {
        initialized: true,
        loading: false,
        items,
        pendingChanges,
        pendingCount,
        status: pendingCount === 0 ? "All changes are stored locally" : `${pendingCount} change${pendingCount === 1 ? "" : "s"} waiting to sync`,
        error: null,
      };
      this.emit();
    } catch (error) {
      this.patchState({
        loading: false,
        error: safeError(error),
        status: "Could not open the browser library",
      });
    }
  }

  private async write(operation: (database: BrowserDatabase) => Promise<void>): Promise<void> {
    const execute = async () => operation(await browserDatabase());
    try {
      if (!navigator.locks) {
        throw new Error(
          "Safe library writes require a browser with cross-tab Web Locks support.",
        );
      }
      await navigator.locks.request(WRITE_LOCK, execute);
    } catch (error) {
      this.patchState({ error: safeError(error), status: "Change was not saved" });
      throw error;
    }
  }

  private async afterCommit(status: string): Promise<void> {
    this.channel.postMessage({ type: "changed" });
    await this.load();
    this.patchState({ status, error: null });
  }

  private patchState(patch: Partial<LibraryState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

async function readPersisted(database: BrowserDatabase): Promise<{
  meta: PersistedLibraryMeta;
  snapshot: PersistedSnapshot;
}> {
  const [meta, snapshot] = await Promise.all([
    database.get("meta", "library"),
    database.get("state", "canonical"),
  ]);
  if (!meta || !snapshot) throw new Error("The browser library is incomplete.");
  return { meta, snapshot };
}

async function replaceItems(
  store: {
    clear(): Promise<unknown>;
    put(value: PersistedItem): Promise<unknown>;
  },
  items: PersistedItem[],
): Promise<void> {
  await store.clear();
  for (const item of items) await store.put(item);
}

function materializeProjection(projection: RawProjection): PersistedItem[] {
  if (projection.schema_version !== 2 || !Array.isArray(projection.items)) {
    throw new Error("The domain core returned an unsupported browser projection.");
  }
  const itemIds = new Set<string>();
  return projection.items.map((item) => {
    const materialized = materializeItem(item);
    if (itemIds.has(materialized.id)) {
      throw new Error("The domain core returned a duplicate item identity.");
    }
    itemIds.add(materialized.id);
    return materialized;
  });
}

function materializeDeferred(
  pendingIndices: number[],
  combined: RemoteEnvelopeInput[],
): PersistedDeferred[] {
  if (!Array.isArray(pendingIndices)) {
    throw new Error("The domain core returned an invalid deferred-envelope list.");
  }
  const paths = new Set<string>();
  return pendingIndices.map((index) => {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new Error("The domain core returned an invalid deferred-envelope index.");
    }
    const pending = combined[index];
    if (!pending || paths.has(pending.path)) {
      throw new Error("The domain core returned an invalid deferred-envelope index.");
    }
    paths.add(pending.path);
    return {
      path: pending.path,
      envelopeJson: pending.envelopeJson,
    };
  });
}

function abortTransaction(transaction: { abort(): void }): void {
  try {
    transaction.abort();
  } catch {
    // A failed IndexedDB request may already have aborted the transaction.
  }
}

function validateBlobSha(value: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new Error("A remote update has an invalid Git object identity.");
  }
}

function materializeItem(item: RawProjection["items"][number]): PersistedItem {
  if (!Number.isSafeInteger(item.saved_at)) {
    throw new Error("The domain core returned an invalid saved time.");
  }
  const savedAt = new Date(item.saved_at * 1_000);
  if (Number.isNaN(savedAt.getTime())) {
    throw new Error("The domain core returned an invalid saved time.");
  }
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    excerpt: item.excerpt,
    note: item.note,
    favorite: item.favorite,
    language: item.language,
    savedAt: savedAt.toISOString(),
    savedAtUnix: item.saved_at,
    tags: [...item.tags],
    deleted: item.state === "deleted",
  };
}

function mutationItemId(mutation: Record<string, unknown>): string {
  const itemId = mutation.item_id;
  if (typeof itemId !== "string" || itemId.length === 0) {
    throw new Error("A browser mutation is missing its item identity.");
  }
  return itemId;
}

function mutationKind(mutation: Record<string, unknown>): PersistedChangeKind {
  const kind = mutation.type;
  if (kind === "create" || kind === "edit" || kind === "delete" || kind === "restore") {
    return kind;
  }
  throw new Error("A browser mutation has an unsupported change type.");
}

function normalizeMutation(
  mutation: Record<string, unknown>,
  beforeItem: PersistedItem | undefined,
  targetTags?: string[],
): Record<string, unknown> | null {
  const kind = mutationKind(mutation);
  if (kind !== "edit") return mutation;
  if (!beforeItem) {
    throw new Error("That save no longer exists in this browser library.");
  }

  const normalized = { ...mutation };
  if (normalized.url === beforeItem.url) delete normalized.url;
  removeUnchangedTextUpdate(normalized, "title", beforeItem.title);
  removeUnchangedTextUpdate(normalized, "excerpt", beforeItem.excerpt);
  removeUnchangedTextUpdate(normalized, "note", beforeItem.note);
  removeUnchangedTextUpdate(normalized, "language", beforeItem.language);
  if (normalized.favorite === beforeItem.favorite) delete normalized.favorite;

  if (!("note" in normalized)) delete normalized.expected_note;

  if (targetTags !== undefined) {
    const currentTags = new Set(beforeItem.tags);
    const requestedTags = new Set(targetTags);
    const addedTags = targetTags.filter((tag) => !currentTags.has(tag));
    const removedTags = beforeItem.tags.filter((tag) => !requestedTags.has(tag));
    if (addedTags.length > 0) normalized.add_tags = addedTags;
    else delete normalized.add_tags;
    if (removedTags.length > 0) normalized.remove_tags = removedTags;
    else delete normalized.remove_tags;
  }

  const hasChange = Object.keys(normalized).some(
    (key) => key !== "type" && key !== "item_id",
  );
  return hasChange ? normalized : null;
}

function removeUnchangedTextUpdate(
  mutation: Record<string, unknown>,
  field: "title" | "excerpt" | "note" | "language",
  current: string | null,
): void {
  if (!(field in mutation)) return;
  if (textUpdateValue(mutation[field]) === current) delete mutation[field];
}

function textUpdateValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    throw new Error("A browser text change is malformed.");
  }
  const update = value as Partial<TextUpdate>;
  if (update.type === "clear") return null;
  if (update.type === "set" && typeof update.value === "string") return update.value;
  throw new Error("A browser text change is malformed.");
}

function summarizeMutation(
  mutation: Record<string, unknown>,
  beforeItem: PersistedItem | undefined,
  afterItem: PersistedItem | undefined,
): PersistedChangeSummary {
  const kind = mutationKind(mutation);
  const itemId = mutationItemId(mutation);
  if (!afterItem) {
    throw new Error("The domain core omitted the changed item from its projection.");
  }

  const fields: PersistedChangeField[] = [];
  let favorite: boolean | null = null;
  let addedTags: string[] = [];
  let removedTags: string[] = [];

  if (kind === "create") {
    fields.push("url");
    if (afterItem.title) fields.push("title");
    if (afterItem.excerpt) fields.push("excerpt");
    if (afterItem.note) fields.push("note");
    if (afterItem.language) fields.push("language");
    favorite = afterItem.favorite ? true : null;
    addedTags = [...afterItem.tags];
  } else if (kind === "edit") {
    if (!beforeItem) {
      throw new Error("The edited item is missing its previous projection.");
    }
    for (const field of ["url", "title", "excerpt", "note", "language"] as const) {
      if (beforeItem[field] !== afterItem[field]) fields.push(field);
    }
    if (beforeItem.favorite !== afterItem.favorite) favorite = afterItem.favorite;
    addedTags = afterItem.tags.filter((tag) => !beforeItem.tags.includes(tag));
    removedTags = beforeItem.tags.filter((tag) => !afterItem.tags.includes(tag));
  }

  return {
    version: 1,
    kind,
    itemId,
    fields,
    favorite,
    addedTags,
    removedTags,
  };
}

function materializePendingChanges(
  outbox: PersistedOutbox[],
  items: PersistedItem[],
): PendingSyncChange[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return [...outbox]
    .sort(
      (left, right) =>
        left.enqueuedAt.localeCompare(right.enqueuedAt) || left.path.localeCompare(right.path),
    )
    .map((entry) => {
      const summary = isPersistedChangeSummary(entry.summary) ? entry.summary : null;
      if (!summary) {
        return {
          path: entry.path,
          enqueuedAt: entry.enqueuedAt,
          attempts: entry.attempts,
          lastErrorKind: entry.lastErrorKind,
          kind: "queued",
          itemId: null,
          label: "Earlier local change",
          fields: [],
          favorite: null,
          addedTags: [],
          removedTags: [],
        };
      }
      const item = itemsById.get(summary.itemId);
      return {
        path: entry.path,
        enqueuedAt: entry.enqueuedAt,
        attempts: entry.attempts,
        lastErrorKind: entry.lastErrorKind,
        kind: summary.kind,
        itemId: summary.itemId,
        label: pendingItemLabel(item),
        fields: [...summary.fields],
        favorite: summary.favorite,
        addedTags: [...summary.addedTags],
        removedTags: [...summary.removedTags],
      };
    });
}

function isPersistedChangeSummary(value: unknown): value is PersistedChangeSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Partial<PersistedChangeSummary>;
  const kinds: PersistedChangeKind[] = ["create", "edit", "delete", "restore"];
  const fields: PersistedChangeField[] = [
    "url",
    "title",
    "excerpt",
    "note",
    "language",
  ];
  return (
    summary.version === 1 &&
    kinds.includes(summary.kind as PersistedChangeKind) &&
    typeof summary.itemId === "string" &&
    summary.itemId.length > 0 &&
    Array.isArray(summary.fields) &&
    summary.fields.every((field) => fields.includes(field)) &&
    (summary.favorite === null || typeof summary.favorite === "boolean") &&
    Array.isArray(summary.addedTags) &&
    summary.addedTags.every((tag) => typeof tag === "string") &&
    Array.isArray(summary.removedTags) &&
    summary.removedTags.every((tag) => typeof tag === "string")
  );
}

function pendingItemLabel(item: PersistedItem | undefined): string {
  const title = item?.title?.trim();
  if (title) return title;
  if (!item) return "Saved link";
  try {
    return new URL(item.url).hostname.replace(/^www\./, "");
  } catch {
    return "Saved link";
  }
}

function parseProjection(json: string): RawProjection {
  return JSON.parse(json) as RawProjection;
}

function parseEnvelope(envelopeJson: string): EnvelopeIdentity {
  const value = JSON.parse(envelopeJson) as Partial<EnvelopeIdentity>;
  if (
    typeof value.library_id !== "string" ||
    typeof value.device_id !== "string" ||
    typeof value.sequence !== "string" ||
    typeof value.payload_sha256 !== "string"
  ) {
    throw new Error("The domain core returned a malformed immutable envelope.");
  }
  return value as EnvelopeIdentity;
}

function batchRecord(
  path: string,
  envelopeJson: string,
  identity: EnvelopeIdentity,
  origin: "local" | "remote",
  now: string,
): PersistedBatch {
  return {
    path,
    libraryId: identity.library_id,
    deviceId: identity.device_id,
    sequence: identity.sequence,
    payloadSha256: identity.payload_sha256,
    envelopeJson,
    origin,
    appliedAt: now,
  };
}

function validateRemoteIdentity(
  input: RemoteEnvelopeInput,
  identity: EnvelopeIdentity,
  expectedLibraryId: string,
): void {
  if (
    identity.library_id !== expectedLibraryId ||
    input.path !== operationPath(identity.device_id, identity.sequence)
  ) {
    throw new Error("A remote update path does not match its immutable identity.");
  }
}

function validateRemoteArtifacts(
  inputs: RemoteEnvelopeInput[],
  packs: RemoteOperationPackInput[],
  expectedLibraryId: string,
): ValidatedRemoteArtifact[] {
  const artifactPaths = new Set<string>();
  const memberBytesByPath = new Map<string, string>();
  const artifacts: ValidatedRemoteArtifact[] = [];

  const addArtifact = (artifact: ValidatedRemoteArtifact) => {
    if (artifactPaths.has(artifact.path)) {
      throw new Error(`A remote artifact was discovered twice at ${artifact.path}.`);
    }
    artifactPaths.add(artifact.path);
    validateBlobSha(artifact.blobSha);
    for (const member of artifact.members) {
      const existingBytes = memberBytesByPath.get(member.path);
      if (existingBytes !== undefined && existingBytes !== member.envelopeJson) {
        throw new Error(`A remote update identity has conflicting bytes at ${member.path}.`);
      }
      memberBytesByPath.set(member.path, member.envelopeJson);
    }
    artifacts.push(artifact);
  };

  for (const input of inputs) {
    const identity = parseEnvelope(input.envelopeJson);
    validateRemoteIdentity(input, identity, expectedLibraryId);
    addArtifact({
      path: input.path,
      blobSha: input.blobSha,
      members: [{ path: input.path, envelopeJson: input.envelopeJson, identity }],
    });
  }

  for (const pack of packs) {
    if (!pack.path.startsWith("sync/v1/ops/packs/") || pack.memberEnvelopes.length < 2) {
      throw new Error("A remote operation pack is malformed.");
    }
    const members = pack.memberEnvelopes.map((envelopeJson) => {
      const identity = parseEnvelope(envelopeJson);
      if (identity.library_id !== expectedLibraryId) {
        throw new Error("A remote operation pack belongs to another library.");
      }
      return {
        path: operationPath(identity.device_id, identity.sequence),
        envelopeJson,
        identity,
      };
    });
    addArtifact({ path: pack.path, blobSha: pack.blobSha, members });
  }

  return artifacts;
}

function operationPath(deviceId: string, sequence: string): string {
  return `sync/v1/ops/${deviceId}/${sequence}.json`;
}

function textUpdate(value: string | null): TextUpdate {
  return value === null ? { type: "clear" } : { type: "set", value };
}

function exactTags(tags: string[]): string[] {
  return [...new Set(tags.filter((tag) => tag.length > 0))].sort();
}

function incrementSequence(value: string): string {
  const next = BigInt(value) + 1n;
  if (next > U64_MAX) throw new Error("This device exhausted its update sequence.");
  return next.toString().padStart(20, "0");
}

function randomPeerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return (value === 0n ? 1n : value).toString();
}

function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compareItems(left: PersistedItem, right: PersistedItem): number {
  return right.savedAtUnix - left.savedAtUnix || left.id.localeCompare(right.id);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected browser storage error occurred.";
}

export const libraryRepository = new LibraryRepository();
