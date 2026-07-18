import initWasm, {
  createOperationPack,
  createSyncGenesis,
  unpackOperationPack,
  validateSyncGenesis,
} from "../generated/research_domain";

import {
  GENESIS_PATH,
  GitHubClient,
  GitHubSyncError,
  OPS_PREFIX,
  PACKS_PREFIX,
  parseRepository,
  type GitHubRemote,
  type ProtocolTree,
  type RepositoryInfo,
} from "./github.ts";
import {
  libraryRepository,
  type PendingSyncBatch,
  type RemoteEnvelopeInput,
  type RemoteOperationPackInput,
  type SyncConfiguration,
} from "./library.ts";

export interface BrowserSyncState {
  configuration: SyncConfiguration | null;
  credentialAvailable: boolean;
  syncing: boolean;
  status: string;
  error: string | null;
  lastCycle: SyncCycleResult | null;
}

export interface ConnectSyncInput {
  repository: string;
  branch?: string;
  token: string;
  rememberForTab: boolean;
}

export interface UnlockSyncInput {
  token: string;
  rememberForTab: boolean;
}

export interface SyncCycleResult {
  remoteSeen: number;
  downloaded: number;
  applied: number;
  acknowledged: number;
  uploaded: number;
  pending: number;
}

interface PullStats {
  remoteSeen: number;
  downloaded: number;
  applied: number;
  acknowledged: number;
}

interface OperationPackArtifact {
  path: string;
  json: string;
  member_envelopes: string[];
}

interface PendingUpload {
  path: string;
  json: string;
  members: PendingSyncBatch[];
  packed: boolean;
}

const SYNC_LOCK = "researchpocket-v2-github-sync";
const LIBRARY_CHANNEL = "researchpocket-v2-state";
const SESSION_TOKEN_KEY = "researchpocket-v2-github-token";
const MAX_UPLOAD_ATTEMPTS = 4;
const PERIODIC_SYNC_MS = 60_000;
const LOCAL_CHANGE_SYNC_DELAY_MS = 5_000;
const MAX_PACK_MEMBERS = 1_000;
const MAX_PACK_BYTES = 20 * 1024 * 1024;
const PACK_JSON_OVERHEAD_BYTES = 1_024;

let wasmPromise: Promise<unknown> | undefined;

function ensureWasm(): Promise<unknown> {
  wasmPromise ??= initWasm();
  return wasmPromise;
}

class BrowserSyncService {
  private state: BrowserSyncState = {
    configuration: null,
    credentialAvailable: false,
    syncing: false,
    status: "Private sync is not connected",
    error: null,
    lastCycle: null,
  };

  #token: string | null = readSessionToken();
  private retryNotBefore = 0;
  private running: Promise<void> | null = null;
  private localChangeTimer: number | null = null;
  private rerunAfterCurrentSync = false;
  private readonly listeners = new Set<(state: BrowserSyncState) => void>();
  private readonly channel = new BroadcastChannel(LIBRARY_CHANNEL);

  constructor() {
    this.channel.addEventListener("message", () => {
      if (this.#token && this.state.configuration && document.visibilityState === "visible") {
        this.scheduleLocalChangeSync();
      }
    });
    window.addEventListener("focus", () => void this.requestSync("window focus"));
    window.addEventListener("online", () => void this.requestSync("network restored"));
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.requestSync("window visible");
      }
    });
    window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void this.requestSync("periodic refresh");
      }
    }, PERIODIC_SYNC_MS);
    void this.load().catch((error: unknown) => {
      this.patch({
        status: "Private sync could not open",
        error: error instanceof Error ? error.message : "Could not read sync configuration.",
      });
    });
  }

  getState(): BrowserSyncState {
    return this.state;
  }

  subscribe(listener: (state: BrowserSyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  async connect(input: ConnectSyncInput): Promise<void> {
    const [owner, repository] = parseRepository(input.repository);
    this.setCredential(input.token, input.rememberForTab);
    this.patch({ syncing: true, status: "Checking your private repository…", error: null });
    try {
      if (this.running) await this.running;
      await this.withSyncLock(
        async () => {
          const client = new GitHubClient(this.requireToken());
          const repositoryInfo = await client.inspectRepository(owner, repository);
          const branch = input.branch?.trim() || repositoryInfo.defaultBranch;
          if (repositoryInfo.empty && branch !== repositoryInfo.defaultBranch) {
            throw new GitHubSyncError(
              "An empty repository must be initialized on its default branch.",
              "configuration",
            );
          }
          const remote = { owner, repository, branch };
          await this.connectGenesis(client, remote, repositoryInfo);
          const configuration = await libraryRepository.configureSync(
            owner,
            repository,
            branch,
          );
          this.patch({ configuration });
          await this.runConfigured(client, remote);
        },
        true,
      );
    } catch (error) {
      await this.handleFailure(error);
      throw error;
    } finally {
      this.patch({ syncing: false });
    }
  }

  async unlock(input: UnlockSyncInput): Promise<void> {
    if (!this.state.configuration) {
      throw new Error("Connect a private synchronization repository first.");
    }
    this.setCredential(input.token, input.rememberForTab);
    await this.syncNow();
  }

  async syncNow(): Promise<void> {
    await this.requestSync("manual sync", true);
  }

  forgetCredential(): void {
    this.#token = null;
    removeSessionToken();
    this.patch({
      credentialAvailable: false,
      status: this.state.configuration
        ? "Repository connected — enter your token to synchronize"
        : "Private sync is not connected",
      error: null,
    });
  }

  private async load(): Promise<void> {
    const configuration = await libraryRepository.syncConfiguration();
    this.patch({
      configuration,
      credentialAvailable: this.#token !== null,
      status: configuration
        ? this.#token
          ? "Private sync ready"
          : "Repository connected — enter your token to synchronize"
        : "Private sync is not connected",
    });
    if (configuration && this.#token) void this.requestSync("startup");
  }

  private async requestSync(reason: string, force = false): Promise<void> {
    if (this.running) {
      if (reason === "local changes") this.rerunAfterCurrentSync = true;
      return this.running;
    }
    if (!this.#token || !this.state.configuration) return;
    if (!navigator.onLine) {
      const error = new GitHubSyncError(
        "You are offline. Your queued changes remain stored here and will retry when the network returns.",
        "transport",
      );
      if (force) {
        await this.handleFailure(error);
        throw error;
      }
      return;
    }
    if (Date.now() < this.retryNotBefore) {
      if (force) {
        const seconds = Math.ceil((this.retryNotBefore - Date.now()) / 1_000);
        const error = new GitHubSyncError(
          `GitHub asked this browser to wait ${seconds} more seconds before retrying.`,
          "rate_limited",
          seconds,
        );
        this.patch({ status: "Private sync is waiting to retry", error: error.message });
        throw error;
      }
      return;
    }
    this.running = this.withSyncLock(async () => {
      const configuration = await libraryRepository.syncConfiguration();
      if (!configuration || !this.#token) return;
      this.patch({
        configuration,
        syncing: true,
        status: reason === "manual sync" ? "Synchronizing now…" : "Synchronizing private changes…",
        error: null,
      });
      const client = new GitHubClient(this.requireToken());
      await this.runConfigured(client, remoteFrom(configuration));
    }, force)
      .catch(async (error: unknown) => {
        await this.handleFailure(error);
        if (force) throw error;
      })
      .finally(() => {
        const rerun = this.rerunAfterCurrentSync;
        this.rerunAfterCurrentSync = false;
        this.patch({ syncing: false });
        this.running = null;
        if (rerun) this.scheduleLocalChangeSync(0);
      });
    return this.running;
  }

  private scheduleLocalChangeSync(delay = LOCAL_CHANGE_SYNC_DELAY_MS): void {
    if (this.localChangeTimer !== null) window.clearTimeout(this.localChangeTimer);
    this.localChangeTimer = window.setTimeout(() => {
      this.localChangeTimer = null;
      void libraryRepository
        .pendingSyncBatches()
        .then((pending) => {
          if (pending.length > 0) return this.requestSync("local changes");
        })
        .catch(() => undefined);
    }, delay);
  }

  private async withSyncLock(
    operation: () => Promise<void>,
    waitForLock: boolean,
  ): Promise<void> {
    if (!navigator.locks) {
      throw new Error("Safe synchronization requires a browser with Web Locks support.");
    }
    if (waitForLock) {
      await navigator.locks.request(SYNC_LOCK, operation);
    } else {
      await navigator.locks.request(
        SYNC_LOCK,
        { ifAvailable: true },
        async (lock) => {
          if (lock) await operation();
        },
      );
    }
  }

  private async connectGenesis(
    client: GitHubClient,
    remote: GitHubRemote,
    repositoryInfo: RepositoryInfo,
  ): Promise<void> {
    let emptyBootstrap = repositoryInfo.empty;
    for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      const tree = emptyBootstrap ? emptyProtocolTree() : await client.discover(remote);
      const remoteGenesisSha = tree.blobs.get(GENESIS_PATH);
      if (remoteGenesisSha) {
        const genesisJson = await client.downloadText(remote, remoteGenesisSha);
        await ensureWasm();
        const remoteLibraryId = validatedGenesisLibraryId(genesisJson);
        await libraryRepository.adoptRemoteLibraryIfPristine(remoteLibraryId);
        await libraryRepository.recordRemoteObservation(GENESIS_PATH, remoteGenesisSha);
        return;
      }
      if (
        [...tree.blobs.keys()].some(
          (path) => path.startsWith(OPS_PREFIX) || path.startsWith("sync/v1/checkpoints/"),
        )
      ) {
        throw new GitHubSyncError(
          "The repository contains synchronization updates without immutable library genesis.",
          "integrity",
        );
      }

      const identity = await libraryRepository.syncIdentity();
      await ensureWasm();
      const genesisJson = createSyncGenesis(identity.libraryId, identity.createdAt);
      const put = await client.putNew(
        remote,
        GENESIS_PATH,
        genesisJson,
        emptyBootstrap ? null : remote.branch,
      );
      if (put.type === "created") {
        await libraryRepository.recordRemoteObservation(GENESIS_PATH, put.blobSha);
        return;
      }
      emptyBootstrap = false;
      await retryDelay(GENESIS_PATH, attempt);
    }
    throw new GitHubSyncError(
      "Repository initialization remained contended after safe retries.",
      "contention",
    );
  }

  private async runConfigured(client: GitHubClient, remote: GitHubRemote): Promise<void> {
    await client.inspectRepository(remote.owner, remote.repository);
    let pull = await this.pullRemote(client, remote);
    let uploaded = 0;
    const pendingAtFlushStart = await libraryRepository.pendingSyncBatches();
    const uploads = await buildPendingUploads(pendingAtFlushStart);
    for (const pending of uploads) {
      const upload = await this.ensureUploaded(client, remote, pending);
      uploaded += upload.created ? pending.members.length : 0;
      pull = addPullStats(pull, upload.pull);
    }
    pull = addPullStats(pull, await this.pullRemote(client, remote));
    const pending = (await libraryRepository.pendingSyncBatches()).length;
    const result: SyncCycleResult = {
      ...pull,
      uploaded,
      pending,
    };
    await libraryRepository.recordSyncSuccess();
    this.retryNotBefore = 0;
    this.patch({
      configuration: await libraryRepository.syncConfiguration(),
      lastCycle: result,
      status:
        pending === 0
          ? "Private library synchronized"
          : `${pending} change${pending === 1 ? "" : "s"} still queued`,
      error: null,
    });
  }

  private async pullRemote(client: GitHubClient, remote: GitHubRemote): Promise<PullStats> {
    const tree = await client.discover(remote);
    await this.validateRemoteGenesis(client, remote, tree);
    const operations = [...tree.blobs.entries()]
      .filter(([path]) => path.startsWith(OPS_PREFIX))
      .sort(([left], [right]) => left.localeCompare(right));
    const inputs: RemoteEnvelopeInput[] = [];
    const packs: RemoteOperationPackInput[] = [];
    let downloaded = 0;
    for (const [path, blobSha] of operations) {
      const observation = await libraryRepository.remoteObservation(path);
      if (observation) {
        if (observation.blobSha !== blobSha) {
          throw new GitHubSyncError(
            "An immutable remote update changed after it was observed.",
            "integrity",
          );
        }
        continue;
      }
      const json = await client.downloadText(remote, blobSha);
      if (path.startsWith(PACKS_PREFIX)) {
        const pack = await unpackRemotePack(path, blobSha, json);
        packs.push(pack);
        downloaded += 1;
      } else {
        inputs.push({ path, blobSha, envelopeJson: json });
        downloaded += 1;
      }
    }
    const pendingBefore = (await libraryRepository.pendingSyncBatches()).length;
    const applied = await this.applyRemoteUpdates(inputs, packs);
    if ((await libraryRepository.deferredSyncCount()) > 0) {
      throw new GitHubSyncError(
        "Remote updates are missing a causal predecessor. No local changes were uploaded.",
        "integrity",
      );
    }
    const pendingAfter = (await libraryRepository.pendingSyncBatches()).length;
    return {
      remoteSeen: operations.length,
      downloaded,
      applied,
      acknowledged: Math.max(0, pendingBefore - pendingAfter),
    };
  }

  private async validateRemoteGenesis(
    client: GitHubClient,
    remote: GitHubRemote,
    tree: ProtocolTree,
  ): Promise<void> {
    const sha = tree.blobs.get(GENESIS_PATH);
    if (!sha) {
      throw new GitHubSyncError(
        "The configured repository has no immutable library genesis.",
        "integrity",
      );
    }
    const observation = await libraryRepository.remoteObservation(GENESIS_PATH);
    if (observation?.blobSha !== undefined && observation.blobSha !== sha) {
      throw new GitHubSyncError(
        "The immutable library genesis changed after it was observed.",
        "integrity",
      );
    }
    if (!observation) {
      const genesisJson = await client.downloadText(remote, sha);
      await ensureWasm();
      const remoteLibraryId = validatedGenesisLibraryId(genesisJson);
      const local = await libraryRepository.syncIdentity();
      if (remoteLibraryId !== local.libraryId) {
        throw new GitHubSyncError(
          "The remote repository belongs to a different ResearchPocket library.",
          "library_mismatch",
        );
      }
      await libraryRepository.recordRemoteObservation(GENESIS_PATH, sha);
    }
  }

  private async ensureUploaded(
    client: GitHubClient,
    remote: GitHubRemote,
    pending: PendingUpload,
  ): Promise<{ created: boolean; pull: PullStats }> {
    let racePull = emptyPullStats();
    for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      const tree = await client.discover(remote);
      const existingSha = tree.blobs.get(pending.path);
      if (existingSha) {
        const existingJson = await client.downloadText(remote, existingSha);
        await this.applyUploadedArtifact(pending, existingSha, existingJson);
        return { created: false, pull: racePull };
      }

      let put;
      try {
        put = await client.putNew(
          remote,
          pending.path,
          pending.json,
          remote.branch,
        );
      } catch (error) {
        await libraryRepository.recordOutboxAttempts(
          pending.members.map((member) => member.path),
          error instanceof GitHubSyncError ? error.kind : "transport",
        );
        throw error;
      }
      if (put.type === "created") {
        await libraryRepository.recordOutboxAttempts(
          pending.members.map((member) => member.path),
          null,
        );
        await this.applyUploadedArtifact(pending, put.blobSha, pending.json);
        return { created: true, pull: racePull };
      }
      await libraryRepository.recordOutboxAttempts(
        pending.members.map((member) => member.path),
        put.type === "race" ? "contention" : put.kind,
      );
      racePull = addPullStats(racePull, await this.pullRemote(client, remote));
      await retryDelay(pending.path, attempt);
    }
    throw new GitHubSyncError(
      "Synchronization remained contended after safe retries.",
      "contention",
    );
  }

  private async applyUploadedArtifact(
    pending: PendingUpload,
    blobSha: string,
    json: string,
  ): Promise<void> {
    if (pending.packed) {
      const pack = await unpackRemotePack(pending.path, blobSha, json);
      await this.applyRemoteUpdates([], [pack]);
      return;
    }
    await this.applyRemoteUpdates([
      { path: pending.path, blobSha, envelopeJson: json },
    ]);
  }

  private async applyRemoteUpdates(
    inputs: RemoteEnvelopeInput[],
    packs: RemoteOperationPackInput[] = [],
  ): Promise<number> {
    try {
      return await libraryRepository.applyRemote(inputs, packs);
    } catch (error) {
      if (error instanceof DOMException) throw error;
      throw new GitHubSyncError(
        "A remote immutable update failed shared protocol or convergence validation.",
        "integrity",
      );
    }
  }

  private setCredential(token: string, rememberForTab: boolean): void {
    const normalizedToken = token.trim();
    const client = new GitHubClient(normalizedToken);
    void client;
    this.#token = normalizedToken;
    try {
      if (rememberForTab) writeSessionToken(normalizedToken);
      else removeSessionToken();
    } catch (error) {
      this.#token = null;
      throw error;
    }
    this.patch({ credentialAvailable: true, error: null });
  }

  private requireToken(): string {
    if (!this.#token) {
      throw new GitHubSyncError(
        "Enter your repository-scoped GitHub token to synchronize.",
        "authentication",
      );
    }
    return this.#token;
  }

  private async handleFailure(error: unknown): Promise<void> {
    const syncError = normalizeError(error);
    if (this.state.configuration) {
      await libraryRepository.recordSyncFailure(syncError.kind).catch(() => undefined);
      this.patch({ configuration: await libraryRepository.syncConfiguration() });
    }
    if (
      [
        "authentication",
        "authorization",
        "integrity",
        "library_mismatch",
        "upgrade_required",
      ].includes(syncError.kind)
    ) {
      this.forgetCredential();
    }
    if (syncError.retryAfterSeconds !== null) {
      this.retryNotBefore = Date.now() + syncError.retryAfterSeconds * 1_000;
    }
    this.patch({ status: "Private sync needs attention", error: syncError.message });
  }

  private patch(patch: Partial<BrowserSyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

async function buildPendingUploads(
  pending: PendingSyncBatch[],
): Promise<PendingUpload[]> {
  const chunks = chunkPendingBatches(pending);
  if (chunks.some((chunk) => chunk.length > 1)) await ensureWasm();

  return chunks.map((members) => {
    const first = members[0];
    if (!first) {
      throw new GitHubSyncError(
        "The browser outbox produced an empty synchronization upload.",
        "local_state",
      );
    }
    if (members.length === 1) {
      return {
        path: first.path,
        json: first.envelopeJson,
        members,
        packed: false,
      };
    }

    try {
      const expectedEnvelopes = members.map((member) => member.envelopeJson);
      const artifact = parseOperationPackArtifact(
        createOperationPack(JSON.stringify(expectedEnvelopes)),
      );
      if (
        artifact.member_envelopes.length !== expectedEnvelopes.length ||
        artifact.member_envelopes.some(
          (envelope, index) => envelope !== expectedEnvelopes[index],
        )
      ) {
        throw new Error("The shared domain core changed the queued envelope bytes.");
      }
      return {
        path: artifact.path,
        json: artifact.json,
        members,
        packed: true,
      };
    } catch (error) {
      if (error instanceof GitHubSyncError) throw error;
      throw new GitHubSyncError(
        "Queued changes failed shared operation-pack validation and remain safely stored here.",
        "local_state",
      );
    }
  });
}

function chunkPendingBatches(pending: PendingSyncBatch[]): PendingSyncBatch[][] {
  const chunks: PendingSyncBatch[][] = [];
  let current: PendingSyncBatch[] = [];
  let currentDevice = "";
  let estimatedBytes = PACK_JSON_OVERHEAD_BYTES;

  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    currentDevice = "";
    estimatedBytes = PACK_JSON_OVERHEAD_BYTES;
  };

  for (const batch of [...pending].sort((left, right) => left.path.localeCompare(right.path))) {
    const device = pendingBatchDevice(batch.path);
    const memberBytes = estimatedEncodedMemberBytes(batch.envelopeJson);
    const memberFitsPack = PACK_JSON_OVERHEAD_BYTES + memberBytes <= MAX_PACK_BYTES;
    if (!memberFitsPack) {
      flush();
      chunks.push([batch]);
      continue;
    }
    if (
      current.length > 0 &&
      (currentDevice !== device ||
        current.length >= MAX_PACK_MEMBERS ||
        estimatedBytes + memberBytes > MAX_PACK_BYTES)
    ) {
      flush();
    }
    currentDevice = device;
    current.push(batch);
    estimatedBytes += memberBytes;
  }
  flush();
  return chunks;
}

function pendingBatchDevice(path: string): string {
  const match = /^sync\/v1\/ops\/([^/]+)\/\d{20}\.json$/.exec(path);
  if (!match?.[1] || match[1] === "packs") {
    throw new GitHubSyncError(
      "The browser outbox contains an invalid immutable update path.",
      "local_state",
    );
  }
  return match[1];
}

function estimatedEncodedMemberBytes(envelopeJson: string): number {
  const exactBytes = new TextEncoder().encode(envelopeJson).byteLength;
  return 4 * Math.ceil(exactBytes / 3) + 3;
}

async function unpackRemotePack(
  path: string,
  blobSha: string,
  json: string,
): Promise<RemoteOperationPackInput> {
  try {
    await ensureWasm();
    const artifact = parseOperationPackArtifact(unpackOperationPack(path, json));
    if (artifact.path !== path || artifact.json !== json) {
      throw new Error("The shared domain core changed the immutable pack bytes.");
    }
    return {
      path,
      blobSha,
      memberEnvelopes: artifact.member_envelopes,
    };
  } catch (error) {
    if (error instanceof GitHubSyncError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const upgradeRequired = /unsupported (?:protocol|operation pack|feature)/i.test(message);
    throw new GitHubSyncError(
      upgradeRequired
        ? "This private library uses a newer packed synchronization format. Upgrade ResearchPocket before syncing."
        : "A remote operation pack is malformed or failed its content-address check.",
      upgradeRequired ? "upgrade_required" : "integrity",
    );
  }
}

function parseOperationPackArtifact(json: string): OperationPackArtifact {
  const value = JSON.parse(json) as Partial<OperationPackArtifact>;
  if (
    typeof value.path !== "string" ||
    !value.path.startsWith(PACKS_PREFIX) ||
    typeof value.json !== "string" ||
    !Array.isArray(value.member_envelopes) ||
    value.member_envelopes.length < 2 ||
    value.member_envelopes.length > MAX_PACK_MEMBERS ||
    value.member_envelopes.some((envelope) => typeof envelope !== "string") ||
    new TextEncoder().encode(value.json).byteLength > MAX_PACK_BYTES
  ) {
    throw new Error("The shared domain core returned an invalid operation-pack artifact.");
  }
  return value as OperationPackArtifact;
}

function remoteFrom(configuration: SyncConfiguration): GitHubRemote {
  return {
    owner: configuration.owner,
    repository: configuration.repository,
    branch: configuration.branch,
  };
}

function emptyProtocolTree(): ProtocolTree {
  return { blobs: new Map() };
}

function emptyPullStats(): PullStats {
  return { remoteSeen: 0, downloaded: 0, applied: 0, acknowledged: 0 };
}

function addPullStats(left: PullStats, right: PullStats): PullStats {
  return {
    remoteSeen: left.remoteSeen + right.remoteSeen,
    downloaded: left.downloaded + right.downloaded,
    applied: left.applied + right.applied,
    acknowledged: left.acknowledged + right.acknowledged,
  };
}

function normalizeError(error: unknown): GitHubSyncError {
  if (error instanceof GitHubSyncError) return error;
  return new GitHubSyncError(
    error instanceof Error
      ? error.message
      : "Private synchronization could not finish. Your local changes remain queued.",
    "local_state",
  );
}

function validatedGenesisLibraryId(genesisJson: string): string {
  try {
    return validateSyncGenesis(genesisJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const upgradeRequired = /unsupported (?:protocol|domain schema|Loro codec|feature)/i.test(
      message,
    );
    throw new GitHubSyncError(
      upgradeRequired
        ? "This private library uses a newer synchronization format. Upgrade ResearchPocket before syncing."
        : "The repository's immutable library genesis is malformed or incompatible.",
      upgradeRequired ? "upgrade_required" : "integrity",
    );
  }
}

async function retryDelay(path: string, attempt: number): Promise<void> {
  let state = 0;
  for (const character of path) state = (Math.imul(state, 33) ^ character.charCodeAt(0)) >>> 0;
  const jitter = state % 173;
  const base = 200 * 2 ** Math.min(attempt, 4);
  await new Promise((resolve) => window.setTimeout(resolve, base + jitter));
}

function readSessionToken(): string | null {
  try {
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    return token?.trim() ? token : null;
  } catch {
    return null;
  }
}

function writeSessionToken(token: string): void {
  try {
    sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    throw new GitHubSyncError(
      "This browser blocked tab-only token storage. Leave the option off to keep it in memory.",
      "local_state",
    );
  }
}

function removeSessionToken(): void {
  try {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // The in-memory token is still forgotten even if storage is unavailable.
  }
}

export const browserSync = new BrowserSyncService();
