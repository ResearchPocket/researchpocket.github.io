import {
  openBrowserDatabase,
  type BrowserDatabase,
  type CapturedDocumentReference,
  type PersistedBatch,
  type PersistedCheckpoint,
  type PersistedCheckpointCoverage,
  type PersistedChangeField,
  type PersistedChangeKind,
  type PersistedChangeSummary,
  type PersistedDeferred,
  type PersistedItem,
  type PersistedLibraryMeta,
  type PersistedOutbox,
  type PersistedSnapshot,
  type PersistedSyncConfiguration,
  type PersistedZenDocument,
  type RemoteObservation,
} from "./db";
import { domainCore } from "./domain.ts";
import { extractMentions, type GraphMentionSource } from "./graph.ts";
import {
  createUndoableChange,
  matchesUndoExpectation,
  type UndoableChange,
} from "./undo.ts";
import {
  activeProfile,
  profileStorageNames,
  setActiveProfile,
  type LibraryProfile,
  type ProfileStorageNames,
} from "./profiles.ts";

export type { UndoableChange } from "./undo.ts";
export type { LibraryProfile } from "./profiles.ts";
export type { CapturedDocumentReference } from "./db.ts";

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
  pristine: boolean;
}

export interface BrowserCheckpointCandidate {
  path: string;
  json: string;
  checkpointId: string;
  batchCount: number;
}

export interface BrowserCheckpointResult {
  batchCount: number;
  restored: boolean;
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
    captured_document?: CapturedDocumentReference;
    tags: string[];
    state: "active" | "deleted";
  }>;
}

interface MutationResult {
  snapshot: string;
  item: RawProjection["items"][number];
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

interface EnvelopeDetails extends EnvelopeIdentity {
  created_at: string;
  payload: string;
}

interface CheckpointArtifact {
  path: string;
  json: string;
  checkpoint_id: string;
  created_at: string;
  batch_count: number;
  coverage: PersistedCheckpointCoverage;
  snapshot_base64: string;
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

const U64_MAX = 18_446_744_073_709_551_615n;

/** Must track `DOMAIN_SCHEMA_VERSION` in the Rust core. */
const DOMAIN_SCHEMA_VERSION = 3;
const CHECKPOINT_BATCH_THRESHOLD = 100;
const CHECKPOINT_PAYLOAD_THRESHOLD = 2 * 1024 * 1024;

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
  private readonly names: ProfileStorageNames;
  private readonly channel: BroadcastChannel;
  private readonly pending = new Set<Promise<unknown>>();
  private databasePromise: Promise<BrowserDatabase> | undefined;
  private closed = false;
  /** Derived zen mention index, keyed by document and replica revision. */
  private mentions = new Map<string, { updatedAt: string; itemIds: string[] }>();

  constructor(names: ProfileStorageNames) {
    this.names = names;
    this.channel = new BroadcastChannel(names.stateChannel);
    this.channel.addEventListener("message", () => {
      void this.load();
    });
    window.addEventListener("researchpocket:database-blocked", this.onDatabaseBlocked);
    void this.load();
  }

  private readonly onDatabaseBlocked = (): void => {
    this.patchState({
      error: "Another tab is finishing a library upgrade. Close older tabs and retry.",
      status: "Library upgrade blocked",
    });
  };

  private database(): Promise<BrowserDatabase> {
    this.databasePromise ??= openBrowserDatabase(this.names.database);
    return this.databasePromise;
  }

  /**
   * Waits for every write already in flight, then releases this profile's
   * database, channel, and listeners. A switch must not leave a transaction
   * running against the library the user just left.
   */
  async close(): Promise<void> {
    this.closed = true;
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
    window.removeEventListener("researchpocket:database-blocked", this.onDatabaseBlocked);
    this.channel.close();
    this.listeners.clear();
    if (this.databasePromise) {
      const database = await this.databasePromise.catch(() => null);
      database?.close();
    }
  }

  private track<T>(work: Promise<T>): Promise<T> {
    const entry: Promise<T> = work.finally(() => {
      this.pending.delete(entry);
    });
    this.pending.add(entry);
    return entry;
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
      const now = new Date().toISOString();
      const meta: PersistedLibraryMeta = {
        key: "library",
        libraryId: uuidV7(),
        deviceId: uuidV7(),
        peerId: randomPeerId(),
        nextSequence: "00000000000000000001",
        createdAt: now,
      };
      const snapshot = await domainCore.call("initializeLibrary", meta.peerId);
      const projection = parseProjection(
        await domainCore.call("materializeLibrary", snapshot, meta.peerId),
      );
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

  async add(input: AddItemInput): Promise<UndoableChange | null> {
    const itemId = uuidV7();
    return this.commitMutation({
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

  async edit(itemId: string, input: EditItemInput): Promise<UndoableChange | null> {
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
    return this.commitMutation(
      mutation,
      input.tags === undefined ? undefined : exactTags(input.tags),
    );
  }

  async remove(itemId: string): Promise<UndoableChange | null> {
    return this.commitMutation({ type: "delete", item_id: itemId });
  }

  async restore(itemId: string): Promise<UndoableChange | null> {
    return this.commitMutation({ type: "restore", item_id: itemId });
  }

  async undo(change: UndoableChange): Promise<void> {
    await this.commitMutation(
      change.mutation,
      change.targetTags,
      change.expectedItem,
    );
  }

  async syncIdentity(): Promise<BrowserSyncIdentity> {
    const database = await this.database();
    const meta = await database.get("meta", "library");
    if (!meta) throw new Error("Create the browser library before connecting sync.");
    const counts = await Promise.all([
      database.count("items"),
      database.count("batches"),
      database.count("outbox"),
      database.count("deferred"),
    ]);
    return {
      libraryId: meta.libraryId,
      deviceId: meta.deviceId,
      createdAt: meta.createdAt,
      pristine:
        meta.nextSequence === "00000000000000000001" &&
        counts.every((count) => count === 0),
    };
  }

  async syncConfiguration(): Promise<SyncConfiguration | null> {
    return (await (await this.database()).get("syncConfig", "github")) ?? null;
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
        [
          "meta",
          "items",
          "batches",
          "outbox",
          "deferred",
          "remoteObservations",
          "checkpoints",
          "selectedCheckpoint",
          "capturedDocuments",
        ],
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
          transaction.objectStore("checkpoints").count(),
          transaction.objectStore("selectedCheckpoint").count(),
          transaction.objectStore("capturedDocuments").count(),
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
    const database = await this.database();
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
    return (await (await this.database()).get("remoteObservations", path)) ?? null;
  }

  async capturedDocument(
    reference: CapturedDocumentReference,
  ): Promise<string | null> {
    validateCapturedDocumentReference(reference);
    const stored = await (await this.database()).get(
      "capturedDocuments",
      reference.sha256,
    );
    if (!stored) return null;
    if (
      stored.byteLength !== reference.byte_length ||
      new TextEncoder().encode(stored.markdown).byteLength !== reference.byte_length
    ) {
      throw new Error("Stored captured Markdown does not match its item reference.");
    }
    return stored.markdown;
  }

  async storeCapturedDocument(
    reference: CapturedDocumentReference,
    path: string,
    markdown: string,
  ): Promise<void> {
    validateCapturedDocumentReference(reference);
    const byteLength = new TextEncoder().encode(markdown).byteLength;
    if (
      path !== capturedDocumentPath(reference.sha256) ||
      byteLength !== reference.byte_length
    ) {
      throw new Error("Captured Markdown does not match its immutable reference.");
    }
    await this.write(async (database) => {
      const existing = await database.get("capturedDocuments", reference.sha256);
      if (existing && existing.markdown !== markdown) {
        throw new Error("A captured-document identity has conflicting bytes.");
      }
      await database.put("capturedDocuments", {
        sha256: reference.sha256,
        path,
        markdown,
        byteLength,
        storedAt: new Date().toISOString(),
      });
    });
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
    return (await this.database()).count("deferred");
  }

  /**
   * Aggregate operations awaiting upload, oldest first.
   *
   * Ordered by device and sequence so a receiver is never handed an operation
   * before the one it depends on.
   */
  async pendingAggregateOperations(): Promise<PendingAggregateOperation[]> {
    const database = await this.database();
    const outbox = await database.getAll("aggregateOutbox");
    const pending = await Promise.all(
      outbox.map(async (entry) => {
        const batch = await database.get("aggregateBatches", entry.path);
        if (!batch) {
          throw new Error("A queued aggregate operation is missing its immutable batch.");
        }
        return {
          path: entry.path,
          envelopeJson: batch.envelopeJson,
          deviceId: batch.deviceId,
          sequence: batch.sequence,
        };
      }),
    );
    return pending.sort(
      (left, right) =>
        left.deviceId.localeCompare(right.deviceId) ||
        left.sequence.localeCompare(right.sequence),
    );
  }

  async pendingAggregateCount(): Promise<number> {
    return (await this.database()).count("aggregateOutbox");
  }

  async recordAggregateOutboxAttempt(
    path: string,
    errorKind: string | null,
  ): Promise<void> {
    await this.write(async (database) => {
      const entry = await database.get("aggregateOutbox", path);
      if (!entry) return;
      await database.put("aggregateOutbox", {
        ...entry,
        attempts: entry.attempts + 1,
        lastErrorKind: errorKind,
      });
    });
  }

  /**
   * Applies one remote aggregate operation, or declines it.
   *
   * Declining is not a failure: an operation whose causal predecessor has not
   * arrived is reported as `deferred` and nothing is written, so the caller can
   * retry it once that predecessor lands. Recording it as applied would lose it,
   * because the snapshot this store persists does not carry a pending update.
   */
  async receiveRemoteAggregateOperation(
    path: string,
    blobSha: string,
    envelopeJson: string,
  ): Promise<RemoteAggregateOutcome> {
    validateBlobSha(blobSha);
    const envelope = JSON.parse(envelopeJson) as {
      aggregate_kind: string;
      aggregate_id: string;
      device_id: string;
      sequence: string;
      payload_sha256: string;
    };
    // Fails closed rather than skipping: a kind this build cannot apply would
    // otherwise leave a hole in the library that looks like a complete one.
    if (envelope.aggregate_kind !== "zen_document") {
      throw new Error(
        `This library contains ${envelope.aggregate_kind} aggregates, which this version cannot read. Update to continue.`,
      );
    }
    const expected = `sync/v2/ops/zen/${envelope.aggregate_id}/${envelope.device_id}/${envelope.sequence}.json`;
    if (path !== expected) {
      throw new Error("An aggregate operation does not address its own contents.");
    }

    let outcome: RemoteAggregateOutcome = {
      disposition: "deferred",
      acknowledged: false,
    };
    await this.write(async (database) => {
      const meta = await database.get("meta", "library");
      if (!meta) throw new Error("This library is still opening.");
      const known = await database.get("aggregateBatches", path);
      const replica = await database.get("zenReplicas", envelope.aggregate_id);
      const now = new Date().toISOString();

      let applied: ZenEnvelopeResult | null = null;
      if (!known) {
        applied = JSON.parse(
          await domainCore.call(
            "applyZenEnvelope",
            replica?.snapshot ?? "",
            meta.peerId,
            meta.libraryId,
            path,
            envelopeJson,
          ),
        ) as ZenEnvelopeResult;
        if (applied.deferred) {
          outcome = { disposition: "deferred", acknowledged: false };
          return;
        }
      }

      const transaction = database.transaction(
        [
          "zenReplicas",
          "zenDocuments",
          "aggregateBatches",
          "aggregateOutbox",
          "remoteObservations",
        ],
        "readwrite",
      );
      try {
        if (applied?.snapshot && applied.summary) {
          const summary = applied.summary;
          await transaction.objectStore("zenReplicas").put({
            documentId: envelope.aggregate_id,
            snapshot: applied.snapshot,
            updatedAt: now,
          });
          await transaction.objectStore("zenDocuments").put({
            documentId: envelope.aggregate_id,
            title: summary.title,
            byteLength: summary.byte_length,
            todoTotal: summary.todo_total,
            todoDone: summary.todo_done,
            createdAt: summary.created_at,
            editedAt: now,
            tags: summary.tags,
            deleted: summary.lifecycle_state === "deleted",
          });
          await transaction.objectStore("aggregateBatches").add({
            path,
            aggregateKind: envelope.aggregate_kind,
            aggregateId: envelope.aggregate_id,
            deviceId: envelope.device_id,
            sequence: envelope.sequence,
            payloadSha256: envelope.payload_sha256,
            envelopeJson,
            origin: "remote" as const,
            appliedAt: now,
          });
        }
        const outbox = transaction.objectStore("aggregateOutbox");
        const queued = await outbox.get(path);
        if (queued) await outbox.delete(path);
        await transaction
          .objectStore("remoteObservations")
          .put({ path, blobSha, observedAt: now });
        await transaction.done;
        outcome = {
          disposition: known ? "already_applied" : "applied",
          acknowledged: queued !== undefined,
        };
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
    if (outcome.disposition !== "deferred") {
      this.channel.postMessage({ type: "changed" });
      await this.load();
    }
    return outcome;
  }

  async checkpointCandidate(
    force = false,
  ): Promise<BrowserCheckpointCandidate | null> {
    let candidate: BrowserCheckpointCandidate | null = null;
    await this.write(async (database) => {
      if ((await database.count("deferred")) !== 0) return;
      const persisted = await readPersisted(database);
      const selected = await selectedCheckpoint(database);
      const selectedCoverage = selected?.coverage ?? {};
      const intervals: Array<[string, bigint, bigint]> = [];
      for (const [deviceId, ranges] of Object.entries(selectedCoverage)) {
        for (const range of ranges) {
          intervals.push([
            deviceId,
            parseSequence(range.start),
            parseSequence(range.end),
          ]);
        }
      }

      let tailBatches = 0;
      let tailPayloadBytes = 0;
      let createdAt = selected?.createdAt ?? "1970-01-01T00:00:00Z";
      for (const batch of await database.getAll("batches")) {
        const details = parseEnvelopeDetails(batch.envelopeJson);
        intervals.push([
          details.device_id,
          parseSequence(details.sequence),
          parseSequence(details.sequence),
        ]);
        if (details.created_at > createdAt) createdAt = details.created_at;
        if (!coverageContains(selectedCoverage, details.device_id, details.sequence)) {
          tailBatches += 1;
          tailPayloadBytes += decodedBase64Length(details.payload);
        }
      }

      if (
        !force &&
        tailBatches < CHECKPOINT_BATCH_THRESHOLD &&
        tailPayloadBytes < CHECKPOINT_PAYLOAD_THRESHOLD
      ) {
        return;
      }
      if (intervals.length === 0) return;

      const artifact = parseCheckpointArtifact(
        await domainCore.call(
          "createCheckpoint",
          persisted.snapshot.snapshot,
          persisted.meta.libraryId,
          createdAt,
          JSON.stringify(mergeCoverage(intervals)),
        ),
      );
      if (artifact.snapshot_base64 !== persisted.snapshot.snapshot) {
        throw new Error("The domain core changed the checkpoint snapshot bytes.");
      }
      await persistCheckpoint(database, artifact, "local");
      candidate = {
        path: artifact.path,
        json: artifact.json,
        checkpointId: artifact.checkpoint_id,
        batchCount: artifact.batch_count,
      };
    });
    return candidate;
  }

  async receiveRemoteCheckpoint(
    path: string,
    blobSha: string,
    checkpointJson: string,
  ): Promise<BrowserCheckpointResult> {
    validateBlobSha(blobSha);
    const result = await this.write(async (database) => {
      const persisted = await readPersisted(database);
      const artifact = parseCheckpointArtifact(
        await domainCore.call(
          "validateCheckpoint",
          path,
          checkpointJson,
          persisted.meta.libraryId,
        ),
      );
      if (artifact.path !== path || artifact.json !== checkpointJson) {
        throw new Error("The domain core changed immutable checkpoint bytes.");
      }
      const observation = await database.get("remoteObservations", path);
      if (observation && observation.blobSha !== blobSha) {
        throw new Error("An immutable remote checkpoint changed its Git object identity.");
      }
      const counts = await Promise.all([
        database.count("items"),
        database.count("batches"),
        database.count("outbox"),
        database.count("deferred"),
      ]);
      const pristine =
        persisted.meta.nextSequence === "00000000000000000001" &&
        counts.every((count) => count === 0);
      const restored =
        pristine || persisted.snapshot.snapshot === artifact.snapshot_base64;
      const items = pristine
        ? materializeProjection(
            parseProjection(
              await domainCore.call(
                "materializeLibrary",
                artifact.snapshot_base64,
                persisted.meta.peerId,
              ),
            ),
          )
        : [];
      const now = new Date().toISOString();
      const transaction = database.transaction(
        [
          "state",
          "items",
          "checkpoints",
          "selectedCheckpoint",
          "remoteObservations",
        ],
        "readwrite",
      );
      try {
        const checkpoints = transaction.objectStore("checkpoints");
        await persistCheckpointStore(checkpoints, artifact, "remote", now);
        if (pristine) {
          await transaction.objectStore("state").put({
            key: "canonical",
            snapshot: artifact.snapshot_base64,
            updatedAt: now,
          });
          await replaceItems(transaction.objectStore("items"), items);
        }
        if (restored) {
          const selected = await selectedCheckpointFromStores(
            transaction.objectStore("selectedCheckpoint"),
            checkpoints,
          );
          if (!selected || selected.batchCount <= artifact.batch_count) {
            await transaction.objectStore("selectedCheckpoint").put({
              key: "selected",
              checkpointPath: artifact.path,
              selectedAt: now,
            });
          }
        }
        await transaction.objectStore("remoteObservations").put({
          path,
          blobSha,
          observedAt: now,
        });
        await transaction.done;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
      return { batchCount: artifact.batch_count, restored };
    });
    if (result.restored) await this.afterCommit("Library checkpoint restored");
    else this.channel.postMessage({ type: "changed" });
    return result;
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
      const checkpoint = await selectedCheckpoint(database);
      const coverage = checkpoint?.coverage ?? {};
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
          const covered = coverageContains(
            coverage,
            member.identity.device_id,
            member.identity.sequence,
          );
          if (!existing && !covered && !newMemberPaths.has(member.path)) {
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
      const result =
        combined.length === 0
          ? null
          : (JSON.parse(
              await domainCore.call(
                "applyRemoteEnvelopes",
                persisted.snapshot.snapshot,
                persisted.meta.peerId,
                persisted.meta.libraryId,
                JSON.stringify(combined.map((entry) => entry.envelopeJson)),
              ),
            ) as RemoteApplyResult);
      const now = new Date().toISOString();
      const items = result ? materializeProjection(result.projection) : [];
      const pendingRecords = result
        ? materializeDeferred(result.pending_indices, combined)
        : [];
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
        if (result) {
          await transaction.objectStore("state").put({
            key: "canonical",
            snapshot: result.snapshot,
            updatedAt: now,
          });
        }
        for (const item of items) {
          await transaction.objectStore("items").put(item);
        }
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
    expectedItem?: PersistedItem,
  ): Promise<UndoableChange | null> {
    let committed = false;
    let undoableChange: UndoableChange | null = null;
    await this.write(async (database) => {
      const persisted = await readPersisted(database);
      const itemId = mutationItemId(mutation);
      const beforeItem = await database.get("items", itemId);
      if (expectedItem && !matchesUndoExpectation(beforeItem, expectedItem)) {
        throw new Error(
          "This save changed after that action, so the older undo was not applied.",
        );
      }
      const normalizedMutation = normalizeMutation(mutation, beforeItem, targetTags);
      if (!normalizedMutation) return;
      const now = new Date().toISOString();
      const result = JSON.parse(
        await domainCore.call(
          "applyMutation",
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
      const afterItem = materializeItem(result.item);
      if (afterItem.id !== itemId) {
        throw new Error("The domain core omitted the changed item from its projection.");
      }
      const summary = summarizeMutation(normalizedMutation, beforeItem, afterItem);
      undoableChange = createUndoableChange(summary.kind, beforeItem, afterItem);
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
        await transaction.objectStore("items").put(afterItem);
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
    return undoableChange;
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
      const database = await this.database();
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
      const [items, outbox, queuedDocuments] = await Promise.all([
        database.getAll("items"),
        database.getAll("outbox"),
        database.count("aggregateOutbox"),
      ]);
      items.sort(compareItems);
      const pendingChanges = materializePendingChanges(outbox, items);
      // Document edits queue separately but are just as unsynchronized, and a
      // count that ignored them would report "all synced" while they wait.
      const pendingCount = pendingChanges.length + queuedDocuments;
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

  private async write<T>(
    operation: (database: BrowserDatabase) => Promise<T>,
  ): Promise<T> {
    const execute = async () => operation(await this.database());
    try {
      if (this.closed) {
        throw new Error("This library was closed. Reopen it before saving changes.");
      }
      if (!navigator.locks) {
        throw new Error(
          "Safe library writes require a browser with cross-tab Web Locks support.",
        );
      }
      return await this.track(navigator.locks.request(this.names.writeLock, execute));
    } catch (error) {
      this.patchState({ error: safeError(error), status: "Change was not saved" });
      throw error;
    }
  }

  /** Workspace index. Reads metadata only — never a document body. */
  async listZenDocuments(): Promise<PersistedZenDocument[]> {
    const database = await this.database();
    const documents = await database.getAll("zenDocuments");
    return documents
      .filter((document) => !document.deleted)
      .sort(
        (left, right) =>
          right.editedAt.localeCompare(left.editedAt) ||
          left.documentId.localeCompare(right.documentId),
      );
  }

  /**
   * Every zen body reduced to the item UUIDs it mentions, for the library
   * graph's co-mention edges.
   *
   * The result is derived and thrown away: no backlink index is written, no
   * mention travels as an update, and a closed graph leaves nothing behind
   * ([ADR 0012](../../../docs/v2/ADR_0012_DERIVED_LIBRARY_GRAPH.md)). Bodies
   * are expensive to materialize, so each document is cached against its
   * replica's `updatedAt` and only an edited document is read again.
   */
  async listZenMentions(): Promise<GraphMentionSource[]> {
    const database = await this.database();
    const meta = await database.get("meta", "library");
    if (!meta) return [];
    const documents = await database.getAll("zenDocuments");
    const sources: GraphMentionSource[] = [];
    const retained = new Map<string, { updatedAt: string; itemIds: string[] }>();

    for (const document of documents) {
      if (document.deleted) continue;
      const replica = await database.get("zenReplicas", document.documentId);
      if (!replica) continue;

      const cached = this.mentions.get(document.documentId);
      let entry = cached?.updatedAt === replica.updatedAt ? cached : undefined;
      if (!entry) {
        try {
          const view = JSON.parse(
            await domainCore.call(
              "zenDocumentView",
              replica.snapshot,
              meta.peerId,
              document.documentId,
            ),
          ) as ZenDocumentView;
          entry = {
            updatedAt: replica.updatedAt,
            itemIds: extractMentions(view.body),
          };
        } catch {
          // One unreadable document costs its edges, not the whole graph.
          continue;
        }
      }
      retained.set(document.documentId, entry);
      sources.push({ documentId: document.documentId, itemIds: entry.itemIds });
    }

    // Rebuilt rather than pruned, so a deleted document leaves no residue.
    this.mentions = retained;
    return sources;
  }

  /** Reads one document body. The other call that loads body bytes. */
  async zenDocument(documentId: string): Promise<ZenDocumentView> {
    const database = await this.database();
    const replica = await database.get("zenReplicas", documentId);
    if (!replica) throw new Error("That document is no longer in this library.");
    const meta = await database.get("meta", "library");
    if (!meta) throw new Error("This library is still opening.");
    return JSON.parse(
      await domainCore.call(
        "zenDocumentView",
        replica.snapshot,
        meta.peerId,
        documentId,
      ),
    ) as ZenDocumentView;
  }

  async createZenDocument(input: {
    title: string | null;
    body: string;
    tags: string[];
  }): Promise<string> {
    const documentId = uuidV7();
    await this.commitZenMutation(documentId, {
      type: "create",
      document_id: documentId,
      title: input.title,
      body: input.body,
      created_at: Math.floor(Date.now() / 1000),
      tags: input.tags,
    });
    return documentId;
  }

  async setZenTitle(documentId: string, title: string | null): Promise<void> {
    await this.commitZenMutation(documentId, { type: "set_title", title });
  }

  async setZenBody(documentId: string, body: string): Promise<void> {
    await this.commitZenMutation(documentId, { type: "set_body", body });
  }

  async addZenTag(documentId: string, tag: string): Promise<void> {
    await this.commitZenMutation(documentId, { type: "add_tag", tag });
  }

  async removeZenTag(documentId: string, tag: string): Promise<void> {
    await this.commitZenMutation(documentId, { type: "remove_tag", tag });
  }

  async deleteZenDocument(documentId: string): Promise<void> {
    await this.commitZenMutation(documentId, { type: "delete" });
  }

  async restoreZenDocument(documentId: string): Promise<void> {
    await this.commitZenMutation(documentId, { type: "restore" });
  }

  /**
   * Applies one zen mutation and commits replica, index, and queue together.
   *
   * Only the edited document's replica is loaded, so a keystroke never costs
   * anything proportional to the rest of the workspace.
   */
  private async commitZenMutation(
    documentId: string,
    mutation: Record<string, unknown>,
  ): Promise<void> {
    await this.write(async (database) => {
      const meta = await database.get("meta", "library");
      if (!meta) throw new Error("This library is still opening.");
      const replica = await database.get("zenReplicas", documentId);
      if (!replica && mutation.type !== "create") {
        throw new Error("That document is no longer in this library.");
      }
      const now = new Date().toISOString();
      const result = JSON.parse(
        await domainCore.call(
          "applyZenMutation",
          replica?.snapshot ?? "",
          meta.peerId,
          meta.libraryId,
          meta.deviceId,
          meta.nextSequence,
          now,
          documentId,
          JSON.stringify(mutation),
        ),
      ) as ZenMutationResult;

      const path = `sync/v2/ops/zen/${documentId}/${meta.deviceId}/${meta.nextSequence}.json`;
      const summary = result.summary;
      const transaction = database.transaction(
        ["meta", "zenReplicas", "zenDocuments", "aggregateBatches", "aggregateOutbox"],
        "readwrite",
      );
      try {
        await transaction.objectStore("meta").put({
          ...meta,
          nextSequence: incrementSequence(meta.nextSequence),
        });
        await transaction
          .objectStore("zenReplicas")
          .put({ documentId, snapshot: result.snapshot, updatedAt: now });
        await transaction.objectStore("zenDocuments").put({
          documentId,
          title: summary.title,
          byteLength: summary.byte_length,
          todoTotal: summary.todo_total,
          todoDone: summary.todo_done,
          createdAt: summary.created_at,
          editedAt: now,
          tags: summary.tags,
          deleted: summary.lifecycle_state === "deleted",
        });
        await transaction.objectStore("aggregateBatches").add({
          path,
          aggregateKind: "zen_document",
          aggregateId: documentId,
          deviceId: meta.deviceId,
          sequence: meta.nextSequence,
          payloadSha256: JSON.parse(result.envelope).payload_sha256 as string,
          envelopeJson: result.envelope,
          origin: "local" as const,
          appliedAt: now,
        });
        await transaction.objectStore("aggregateOutbox").add({
          path,
          enqueuedAt: now,
          attempts: 0,
          lastErrorKind: null,
        });
        await transaction.done;
      } catch (error) {
        abortTransaction(transaction);
        throw error;
      }
    });
    this.channel.postMessage({ type: "changed" });
    // Reloads so the pending count includes this edit: a document waiting to
    // sync must not read as synchronized.
    await this.load();
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

async function selectedCheckpoint(
  database: BrowserDatabase,
): Promise<PersistedCheckpoint | null> {
  const selected = await database.get("selectedCheckpoint", "selected");
  if (!selected) return null;
  return (await database.get("checkpoints", selected.checkpointPath)) ?? null;
}

type CheckpointStore = {
  get(key: string): Promise<PersistedCheckpoint | undefined>;
  put(value: PersistedCheckpoint): Promise<unknown>;
};

type SelectedCheckpointStore = {
  get(key: "selected"): Promise<
    { key: "selected"; checkpointPath: string; selectedAt: string } | undefined
  >;
};

async function selectedCheckpointFromStores(
  selectedStore: SelectedCheckpointStore,
  checkpointStore: CheckpointStore,
): Promise<PersistedCheckpoint | null> {
  const selected = await selectedStore.get("selected");
  if (!selected) return null;
  return (await checkpointStore.get(selected.checkpointPath)) ?? null;
}

async function persistCheckpoint(
  database: BrowserDatabase,
  artifact: CheckpointArtifact,
  origin: "local" | "remote",
): Promise<void> {
  const transaction = database.transaction("checkpoints", "readwrite");
  try {
    await persistCheckpointStore(
      transaction.objectStore("checkpoints"),
      artifact,
      origin,
      new Date().toISOString(),
    );
    await transaction.done;
  } catch (error) {
    abortTransaction(transaction);
    throw error;
  }
}

async function persistCheckpointStore(
  store: CheckpointStore,
  artifact: CheckpointArtifact,
  origin: "local" | "remote",
  now: string,
): Promise<void> {
  const existing = await store.get(artifact.path);
  if (existing && existing.checkpointJson !== artifact.json) {
    throw new Error("An immutable checkpoint identity has conflicting bytes.");
  }
  if (existing) return;
  await store.put({
    path: artifact.path,
    checkpointId: artifact.checkpoint_id,
    checkpointJson: artifact.json,
    batchCount: artifact.batch_count,
    coverage: artifact.coverage,
    createdAt: artifact.created_at,
    origin,
    appliedAt: now,
  });
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
  if (projection.schema_version !== DOMAIN_SCHEMA_VERSION || !Array.isArray(projection.items)) {
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

function materializeCapturedDocumentReference(
  value: CapturedDocumentReference | undefined,
): CapturedDocumentReference | null {
  if (value === undefined) return null;
  validateCapturedDocumentReference(value);
  return structuredClone(value);
}

function validateCapturedDocumentReference(
  value: CapturedDocumentReference,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.byte_length) ||
    value.byte_length <= 0 ||
    value.byte_length > 4 * 1024 * 1024 ||
    value.media_type !== "text/markdown; charset=utf-8" ||
    typeof value.provenance !== "object" ||
    value.provenance === null ||
    value.provenance.provider !== "firecrawl" ||
    typeof value.provenance.source_url !== "string" ||
    typeof value.provenance.captured_at !== "string"
  ) {
    throw new Error("The domain core returned an invalid captured-document reference.");
  }
}

function capturedDocumentPath(sha256: string): string {
  return `sync/v2/content/sha256/${sha256.slice(0, 2)}/${sha256}.md`;
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
    capturedDocument: materializeCapturedDocumentReference(
      item.captured_document,
    ),
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

function parseEnvelopeDetails(envelopeJson: string): EnvelopeDetails {
  const value = JSON.parse(envelopeJson) as Partial<EnvelopeDetails>;
  parseEnvelope(envelopeJson);
  if (
    typeof value.created_at !== "string" ||
    typeof value.payload !== "string"
  ) {
    throw new Error("An immutable envelope is missing checkpoint metadata.");
  }
  return value as EnvelopeDetails;
}

function parseCheckpointArtifact(json: string): CheckpointArtifact {
  const value = JSON.parse(json) as Partial<CheckpointArtifact>;
  if (
    typeof value.path !== "string" ||
    !/^sync\/v1\/checkpoints\/[0-9a-f]{64}\.json$/.test(value.path) ||
    typeof value.json !== "string" ||
    typeof value.checkpoint_id !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.checkpoint_id) ||
    !value.path.endsWith(`/${value.checkpoint_id}.json`) ||
    typeof value.created_at !== "string" ||
    typeof value.batch_count !== "number" ||
    !Number.isSafeInteger(value.batch_count) ||
    value.batch_count < 0 ||
    typeof value.snapshot_base64 !== "string" ||
    !isCheckpointCoverage(value.coverage)
  ) {
    throw new Error("The domain core returned an invalid checkpoint artifact.");
  }
  const covered = coverageSize(value.coverage);
  if (covered !== BigInt(value.batch_count)) {
    throw new Error("The checkpoint batch count does not match its coverage.");
  }
  return value as CheckpointArtifact;
}

function isCheckpointCoverage(
  value: unknown,
): value is PersistedCheckpointCoverage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  for (const [deviceId, intervals] of Object.entries(value)) {
    if (deviceId.length === 0 || !Array.isArray(intervals) || intervals.length === 0) {
      return false;
    }
    let previousEnd = 0n;
    for (const [index, interval] of intervals.entries()) {
      if (typeof interval !== "object" || interval === null) return false;
      const candidate = interval as Partial<{ start: string; end: string }>;
      if (
        typeof candidate.start !== "string" ||
        typeof candidate.end !== "string"
      ) {
        return false;
      }
      let start: bigint;
      let end: bigint;
      try {
        start = parseSequence(candidate.start);
        end = parseSequence(candidate.end);
      } catch {
        return false;
      }
      if (start > end || (index > 0 && start <= previousEnd)) return false;
      previousEnd = end;
    }
  }
  return true;
}

function coverageContains(
  coverage: PersistedCheckpointCoverage,
  deviceId: string,
  sequence: string,
): boolean {
  const target = parseSequence(sequence);
  return (coverage[deviceId] ?? []).some(
    (interval) =>
      parseSequence(interval.start) <= target &&
      target <= parseSequence(interval.end),
  );
}

function coverageSize(coverage: PersistedCheckpointCoverage): bigint {
  let count = 0n;
  for (const intervals of Object.values(coverage)) {
    for (const interval of intervals) {
      count += parseSequence(interval.end) - parseSequence(interval.start) + 1n;
    }
  }
  return count;
}

function mergeCoverage(
  intervals: Array<[string, bigint, bigint]>,
): PersistedCheckpointCoverage {
  const ordered = [...intervals].sort(
    ([leftDevice, leftStart], [rightDevice, rightStart]) =>
      leftDevice.localeCompare(rightDevice) ||
      (leftStart < rightStart ? -1 : leftStart > rightStart ? 1 : 0),
  );
  const merged = new Map<string, Array<[bigint, bigint]>>();
  for (const [deviceId, start, end] of ordered) {
    const ranges = merged.get(deviceId) ?? [];
    const previous = ranges.at(-1);
    if (previous && start <= previous[1] + 1n) {
      previous[1] = previous[1] > end ? previous[1] : end;
    } else {
      ranges.push([start, end]);
    }
    merged.set(deviceId, ranges);
  }
  return Object.fromEntries(
    [...merged.entries()].map(([deviceId, ranges]) => [
      deviceId,
      ranges.map(([start, end]) => ({
        start: formatSequence(start),
        end: formatSequence(end),
      })),
    ]),
  );
}

function parseSequence(value: string): bigint {
  if (!/^\d{20}$/.test(value)) {
    throw new Error("A synchronization sequence is not a canonical u64.");
  }
  const sequence = BigInt(value);
  if (sequence === 0n || sequence > U64_MAX) {
    throw new Error("A synchronization sequence is outside the supported range.");
  }
  return sequence;
}

function formatSequence(value: bigint): string {
  if (value === 0n || value > U64_MAX) {
    throw new Error("A synchronization sequence is outside the supported range.");
  }
  return value.toString().padStart(20, "0");
}

function decodedBase64Length(value: string): number {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new Error("An immutable envelope has a malformed Base64 payload.");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
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

/**
 * Hooks the sync service uses to stand down across a profile switch. They are
 * registered rather than imported so the library layer keeps no dependency on
 * the sync layer.
 */
export interface SyncBridge {
  /** Resolves once no sync cycle is running and none can start. */
  quiesce(): Promise<void>;
}

export interface ZenSummary {
  document_id: string;
  title: string | null;
  created_at: number;
  byte_length: number;
  todo_total: number;
  todo_done: number;
  tags: string[];
  lifecycle_state: "active" | "deleted";
}

export interface ZenDocumentView {
  document_id: string;
  title: { value: string | null };
  created_at: { value: number };
  body: string;
  tags: string[];
  lifecycle: { state: "active" | "deleted" };
}

interface ZenMutationResult {
  snapshot: string;
  summary: ZenSummary;
  envelope: string;
}

/** Absent snapshot and summary mean the operation was deferred. */
interface ZenEnvelopeResult {
  deferred: boolean;
  snapshot?: string;
  summary?: ZenSummary;
}

export interface PendingAggregateOperation {
  path: string;
  envelopeJson: string;
  deviceId: string;
  sequence: string;
}

export interface RemoteAggregateOutcome {
  disposition: "applied" | "already_applied" | "deferred";
  /** True when this was one of ours coming back — the proof an upload stuck. */
  acknowledged: boolean;
}

const OPENING_STATE: LibraryState = {
  initialized: false,
  loading: true,
  items: [],
  pendingChanges: [],
  pendingCount: 0,
  status: "Opening your private library…",
  error: null,
};

/**
 * Owns whichever profile is currently open and forwards the repository API to
 * it. Every consumer holds this one stable object, so a switch replaces the
 * underlying replica without any component re-wiring its imports.
 */
class LibraryWorkspace {
  private state: LibraryState = OPENING_STATE;
  private readonly listeners = new Set<(state: LibraryState) => void>();
  private readonly profileListeners = new Set<(profile: LibraryProfile) => void>();
  private active: LibraryRepository | null = null;
  private profile: LibraryProfile | null = null;
  private detach: (() => void) | null = null;
  private bridge: SyncBridge | null = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    try {
      this.attach(await activeProfile());
    } catch (error) {
      this.patchState({
        loading: false,
        error: safeError(error),
        status: "Could not open the browser library",
      });
    }
  }

  private attach(profile: LibraryProfile): void {
    const repository = new LibraryRepository(profileStorageNames(profile.namespace));
    this.active = repository;
    this.profile = profile;
    // Emissions from a replaced instance are dropped, so a late resolution
    // from the previous profile can never repaint the new one.
    this.detach = repository.subscribe((next) => {
      if (this.active !== repository) return;
      this.state = next;
      this.emit();
    });
    for (const listener of this.profileListeners) listener(profile);
  }

  private async instance(): Promise<LibraryRepository> {
    await this.ready;
    if (!this.active) throw new Error("The browser library is not open.");
    return this.active;
  }

  registerSyncBridge(bridge: SyncBridge): void {
    this.bridge = bridge;
  }

  activeProfile(): LibraryProfile | null {
    return this.profile;
  }

  subscribeProfile(listener: (profile: LibraryProfile) => void): () => void {
    this.profileListeners.add(listener);
    if (this.profile) listener(this.profile);
    return () => this.profileListeners.delete(listener);
  }

  /**
   * Closes the current profile and opens another. Sync stands down first so no
   * in-flight cycle can apply one profile's updates to the next one.
   */
  async switchProfile(profileId: string): Promise<LibraryProfile> {
    await this.ready;
    if (this.profile?.id === profileId) return this.profile;

    const switching = (async () => {
      const previous = this.active;
      this.active = null;
      this.detach?.();
      this.detach = null;
      this.state = OPENING_STATE;
      this.emit();

      await this.bridge?.quiesce();
      await previous?.close();

      // attach() notifies profile subscribers, which is how sync rebinds.
      const profile = await setActiveProfile(profileId);
      this.attach(profile);
      return profile;
    })();

    this.ready = switching.then(
      () => undefined,
      () => undefined,
    );
    return switching;
  }

  getState(): LibraryState {
    return this.state;
  }

  subscribe(listener: (state: LibraryState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private patchState(patch: Partial<LibraryState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  async initialize(): Promise<void> {
    return (await this.instance()).initialize();
  }

  async add(input: AddItemInput): Promise<UndoableChange | null> {
    return (await this.instance()).add(input);
  }

  async edit(itemId: string, input: EditItemInput): Promise<UndoableChange | null> {
    return (await this.instance()).edit(itemId, input);
  }

  async remove(itemId: string): Promise<UndoableChange | null> {
    return (await this.instance()).remove(itemId);
  }

  async restore(itemId: string): Promise<UndoableChange | null> {
    return (await this.instance()).restore(itemId);
  }

  async undo(change: UndoableChange): Promise<void> {
    return (await this.instance()).undo(change);
  }

  async syncIdentity(): Promise<BrowserSyncIdentity> {
    return (await this.instance()).syncIdentity();
  }

  async syncConfiguration(): Promise<SyncConfiguration | null> {
    return (await this.instance()).syncConfiguration();
  }

  async configureSync(
    owner: string,
    repository: string,
    branch: string,
  ): Promise<SyncConfiguration> {
    return (await this.instance()).configureSync(owner, repository, branch);
  }

  async adoptRemoteLibraryIfPristine(libraryId: string): Promise<boolean> {
    return (await this.instance()).adoptRemoteLibraryIfPristine(libraryId);
  }

  async pendingSyncBatches(): Promise<PendingSyncBatch[]> {
    return (await this.instance()).pendingSyncBatches();
  }

  async remoteObservation(path: string): Promise<RemoteObservation | null> {
    return (await this.instance()).remoteObservation(path);
  }

  async capturedDocument(
    reference: CapturedDocumentReference,
  ): Promise<string | null> {
    return (await this.instance()).capturedDocument(reference);
  }

  async storeCapturedDocument(
    reference: CapturedDocumentReference,
    path: string,
    markdown: string,
  ): Promise<void> {
    return (await this.instance()).storeCapturedDocument(
      reference,
      path,
      markdown,
    );
  }

  async recordRemoteObservation(path: string, blobSha: string): Promise<void> {
    return (await this.instance()).recordRemoteObservation(path, blobSha);
  }

  async recordOutboxAttempt(path: string, errorKind: string | null): Promise<void> {
    return (await this.instance()).recordOutboxAttempt(path, errorKind);
  }

  async recordOutboxAttempts(paths: string[], errorKind: string | null): Promise<void> {
    return (await this.instance()).recordOutboxAttempts(paths, errorKind);
  }

  async deferredSyncCount(): Promise<number> {
    return (await this.instance()).deferredSyncCount();
  }

  async pendingAggregateOperations(): Promise<PendingAggregateOperation[]> {
    return (await this.instance()).pendingAggregateOperations();
  }

  async pendingAggregateCount(): Promise<number> {
    return (await this.instance()).pendingAggregateCount();
  }

  async recordAggregateOutboxAttempt(
    path: string,
    errorKind: string | null,
  ): Promise<void> {
    return (await this.instance()).recordAggregateOutboxAttempt(path, errorKind);
  }

  async receiveRemoteAggregateOperation(
    path: string,
    blobSha: string,
    envelopeJson: string,
  ): Promise<RemoteAggregateOutcome> {
    return (await this.instance()).receiveRemoteAggregateOperation(
      path,
      blobSha,
      envelopeJson,
    );
  }

  async checkpointCandidate(
    force = false,
  ): Promise<BrowserCheckpointCandidate | null> {
    return (await this.instance()).checkpointCandidate(force);
  }

  async receiveRemoteCheckpoint(
    path: string,
    blobSha: string,
    checkpointJson: string,
  ): Promise<BrowserCheckpointResult> {
    return (await this.instance()).receiveRemoteCheckpoint(
      path,
      blobSha,
      checkpointJson,
    );
  }

  async recordSyncSuccess(): Promise<void> {
    return (await this.instance()).recordSyncSuccess();
  }

  async recordSyncFailure(kind: string): Promise<void> {
    return (await this.instance()).recordSyncFailure(kind);
  }

  async applyRemote(
    inputs: RemoteEnvelopeInput[],
    packs: RemoteOperationPackInput[] = [],
  ): Promise<number> {
    return (await this.instance()).applyRemote(inputs, packs);
  }

  async listZenDocuments(): Promise<PersistedZenDocument[]> {
    return (await this.instance()).listZenDocuments();
  }

  async zenDocument(documentId: string): Promise<ZenDocumentView> {
    return (await this.instance()).zenDocument(documentId);
  }

  async listZenMentions(): Promise<GraphMentionSource[]> {
    return (await this.instance()).listZenMentions();
  }

  async createZenDocument(input: {
    title: string | null;
    body: string;
    tags: string[];
  }): Promise<string> {
    return (await this.instance()).createZenDocument(input);
  }

  async setZenTitle(documentId: string, title: string | null): Promise<void> {
    return (await this.instance()).setZenTitle(documentId, title);
  }

  async setZenBody(documentId: string, body: string): Promise<void> {
    return (await this.instance()).setZenBody(documentId, body);
  }

  async addZenTag(documentId: string, tag: string): Promise<void> {
    return (await this.instance()).addZenTag(documentId, tag);
  }

  async removeZenTag(documentId: string, tag: string): Promise<void> {
    return (await this.instance()).removeZenTag(documentId, tag);
  }

  async deleteZenDocument(documentId: string): Promise<void> {
    return (await this.instance()).deleteZenDocument(documentId);
  }

  async restoreZenDocument(documentId: string): Promise<void> {
    return (await this.instance()).restoreZenDocument(documentId);
  }
}

export const libraryRepository = new LibraryWorkspace();
