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
  type PersistedDeferred,
  type PersistedItem,
  type PersistedLibraryMeta,
  type PersistedOutbox,
  type PersistedSnapshot,
} from "./db";

export type LibraryItem = PersistedItem;

export interface LibraryState {
  initialized: boolean;
  loading: boolean;
  items: LibraryItem[];
  pendingCount: number;
  status: string;
  error: string | null;
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
}

export interface RemoteEnvelopeInput {
  path: string;
  blobSha: string;
  envelopeJson: string;
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
    const database = await browserDatabase();
    const current = await database.get("items", itemId);
    if (!current) {
      throw new Error("That save no longer exists in this browser library.");
    }
    const mutation: Record<string, unknown> = { type: "edit", item_id: itemId };
    if (input.url !== undefined) mutation.url = input.url;
    if (input.title !== undefined) mutation.title = textUpdate(input.title);
    if (input.excerpt !== undefined) mutation.excerpt = textUpdate(input.excerpt);
    if (input.note !== undefined) mutation.note = textUpdate(input.note);
    if (input.favorite !== undefined) mutation.favorite = input.favorite;
    if (input.language !== undefined) mutation.language = textUpdate(input.language);
    if (input.tags !== undefined) {
      const nextTags = exactTags(input.tags);
      const currentTags = new Set(current.tags);
      const requestedTags = new Set(nextTags);
      mutation.add_tags = nextTags.filter((tag) => !currentTags.has(tag));
      mutation.remove_tags = current.tags.filter((tag) => !requestedTags.has(tag));
    }
    await this.commitMutation(mutation);
  }

  async remove(itemId: string): Promise<void> {
    await this.commitMutation({ type: "delete", item_id: itemId });
  }

  async restore(itemId: string): Promise<void> {
    await this.commitMutation({ type: "restore", item_id: itemId });
  }

  async applyRemote(inputs: RemoteEnvelopeInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await this.write(async (database) => {
      const persisted = await readPersisted(database);
      const paths = new Set<string>();
      const identities = inputs.map((input) => {
        if (paths.has(input.path)) {
          throw new Error(`A remote update was discovered twice at ${input.path}.`);
        }
        paths.add(input.path);
        const identity = parseEnvelope(input.envelopeJson);
        validateRemoteIdentity(input, identity, persisted.meta.libraryId);
        validateBlobSha(input.blobSha);
        return identity;
      });
      const newInputs: RemoteEnvelopeInput[] = [];
      for (const input of inputs) {
        const [existing, observation] = await Promise.all([
          database.get("batches", input.path),
          database.get("remoteObservations", input.path),
        ]);
        if (existing && existing.envelopeJson !== input.envelopeJson) {
          throw new Error("An immutable remote update changed after it was observed.");
        }
        if (observation && observation.blobSha !== input.blobSha) {
          throw new Error("An immutable remote path changed its Git object identity.");
        }
        if (!existing) newInputs.push(input);
      }
      const deferred = await database.getAll("deferred");
      const combined = [
        ...newInputs,
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
      const newBatchRecords = newInputs.map((input) => {
        const index = inputs.indexOf(input);
        const identity = identities[index];
        if (!identity) throw new Error("A remote update identity is missing.");
        return batchRecord(input.path, input.envelopeJson, identity, "remote", now);
      });
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
        for (const input of inputs) {
          await transaction.objectStore("outbox").delete(input.path);
          await transaction.objectStore("remoteObservations").put({
            path: input.path,
            blobSha: input.blobSha,
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
  }

  private async commitMutation(mutation: Record<string, unknown>): Promise<void> {
    await this.write(async (database) => {
      const persisted = await readPersisted(database);
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
          JSON.stringify(mutation),
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
      const batch = batchRecord(path, result.envelope, identity, "local", now);
      const outbox: PersistedOutbox = {
        path,
        enqueuedAt: now,
        attempts: 0,
        lastErrorKind: null,
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
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
    await this.afterCommit("Saved offline — queued for synchronization");
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
          pendingCount: 0,
          status: "Create an offline library to begin",
          error: null,
        };
        this.emit();
        return;
      }
      const [items, pendingCount] = await Promise.all([
        database.getAll("items"),
        database.count("outbox"),
      ]);
      items.sort(compareItems);
      this.state = {
        initialized: true,
        loading: false,
        items,
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
