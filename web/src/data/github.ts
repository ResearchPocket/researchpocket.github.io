const API_ROOT = "https://api.github.com";
const API_VERSION = "2026-03-10";

export const GENESIS_PATH = "sync/v1/library.json";
export const OPS_PREFIX = "sync/v1/ops/";
export const PACKS_PREFIX = `${OPS_PREFIX}packs/`;

export interface GitHubRemote {
  owner: string;
  repository: string;
  branch: string;
}

export interface RepositoryInfo {
  defaultBranch: string;
  empty: boolean;
}

export interface ProtocolTree {
  blobs: Map<string, string>;
}

export type PutResult =
  | { type: "created"; blobSha: string }
  | { type: "race" }
  | { type: "ambiguous"; kind: "transport" | "server" };

interface RepositoryResponse {
  private: boolean;
  archived: boolean;
  disabled: boolean;
  default_branch: string;
  size: number;
  permissions?: {
    push?: boolean;
  };
}

interface TreeResponse {
  sha: string;
  tree: TreeEntry[];
  truncated: boolean;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

interface BlobResponse {
  content: string;
  encoding: string;
  sha: string;
  size: number;
}

interface PutContentResponse {
  content?: {
    sha?: string;
  } | null;
}

export class GitHubSyncError extends Error {
  readonly kind: string;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, kind: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "GitHubSyncError";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  get retryable(): boolean {
    return ["transport", "rate_limited", "server", "contention"].includes(
      this.kind,
    );
  }
}

export class GitHubClient {
  private readonly headers: Headers;
  private readonly fetcher: typeof fetch;

  constructor(
    token: string,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (token.trim().length === 0 || /[\r\n]/.test(token)) {
      throw new GitHubSyncError(
        "Enter a valid fine-grained GitHub personal access token.",
        "authentication",
      );
    }
    this.headers = new Headers({
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": API_VERSION,
    });
    this.fetcher = fetcher;
  }

  async inspectRepository(owner: string, repository: string): Promise<RepositoryInfo> {
    const response = await this.getJson<RepositoryResponse>(
      repositoryUrl(owner, repository),
    );
    if (!response.private) {
      throw new GitHubSyncError(
        "Choose a private repository for your complete personal library.",
        "repository_policy",
      );
    }
    if (response.archived || response.disabled) {
      throw new GitHubSyncError(
        "That repository is archived or unavailable for synchronization.",
        "repository_policy",
      );
    }
    if (response.permissions?.push !== true) {
      throw new GitHubSyncError(
        "This token does not have read and write access to the selected repository.",
        "authorization",
      );
    }
    if (response.default_branch.trim().length === 0) {
      throw new GitHubSyncError(
        "GitHub did not report a usable default branch.",
        "configuration",
      );
    }
    return {
      defaultBranch: response.default_branch,
      empty: response.size === 0,
    };
  }

  async discover(remote: GitHubRemote): Promise<ProtocolTree> {
    let recursive: TreeResponse;
    try {
      recursive = await this.fetchTree(remote, remote.branch, true);
    } catch (error) {
      if (error instanceof GitHubSyncError && error.kind === "not_found") {
        throw new GitHubSyncError(
          "The selected branch does not exist in that repository.",
          "configuration",
        );
      }
      throw error;
    }
    if (!recursive.truncated) return collectProtocolEntries(recursive.tree, "");

    const protocol: ProtocolTree = { blobs: new Map() };
    const stack: Array<[string, string]> = [[recursive.sha, ""]];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      const [treeSha, prefix] = current;
      const tree = await this.fetchTree(remote, treeSha, false);
      for (const entry of tree.tree) {
        const path = joinPath(prefix, entry.path);
        validateReservedDirectory(path, entry);
        if (entry.type === "tree" && protocolTreeRelevant(path)) {
          stack.push([entry.sha, path]);
        } else if (path.startsWith("sync/v1/")) {
          insertProtocolBlob(protocol, path, entry);
        }
      }
    }
    return protocol;
  }

  async downloadText(remote: GitHubRemote, sha: string): Promise<string> {
    const bytes = await this.downloadBlob(remote, sha);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new GitHubSyncError(
        "A remote synchronization file is not valid UTF-8.",
        "integrity",
      );
    }
  }

  async putNew(
    remote: GitHubRemote,
    path: string,
    text: string,
    branch: string | null,
  ): Promise<PutResult> {
    const body = {
      message: `researchpocket: append ${path}`,
      content: bytesToBase64(new TextEncoder().encode(text)),
      ...(branch === null ? {} : { branch }),
    };
    const headers = new Headers(this.headers);
    headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.fetcher(contentsUrl(remote, path), {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      return { type: "ambiguous", kind: "transport" };
    }

    if (response.status === 201) {
      const created = (await responseJson(response)) as PutContentResponse;
      const sha = created.content?.sha;
      if (typeof sha !== "string") {
        throw new GitHubSyncError(
          "GitHub did not return the immutable blob identity it created.",
          "integrity",
        );
      }
      validateGitSha(sha);
      return { type: "created", blobSha: sha };
    }
    if (response.status === 409 || response.status === 422) {
      return { type: "race" };
    }
    if (response.status >= 500) {
      return { type: "ambiguous", kind: "server" };
    }
    if (response.status === 200) {
      throw new GitHubSyncError(
        "GitHub reported replacing an immutable synchronization path.",
        "integrity",
      );
    }
    throw apiError(response);
  }

  private async fetchTree(
    remote: GitHubRemote,
    treeSha: string,
    recursive: boolean,
  ): Promise<TreeResponse> {
    const url = repositoryUrl(remote.owner, remote.repository, "git", "trees", treeSha);
    if (recursive) url.searchParams.set("recursive", "1");
    return this.getJson<TreeResponse>(url);
  }

  private async downloadBlob(remote: GitHubRemote, sha: string): Promise<Uint8Array> {
    validateGitSha(sha);
    const blob = await this.getJson<BlobResponse>(
      repositoryUrl(remote.owner, remote.repository, "git", "blobs", sha),
    );
    if (blob.sha !== sha || blob.encoding !== "base64") {
      throw new GitHubSyncError(
        "GitHub returned a synchronization blob with the wrong identity or encoding.",
        "integrity",
      );
    }
    const bytes = base64ToBytes(blob.content.replace(/\s/g, ""));
    if (!Number.isSafeInteger(blob.size) || blob.size !== bytes.byteLength) {
      throw new GitHubSyncError(
        "GitHub returned a synchronization blob with an invalid size.",
        "integrity",
      );
    }
    return bytes;
  }

  private async getJson<T>(url: URL): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        headers: this.headers,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new GitHubSyncError(
        "GitHub could not be reached. Your queued changes remain safely stored here.",
        "transport",
      );
    }
    if (!response.ok) throw apiError(response);
    return (await responseJson(response)) as T;
  }
}

export function parseRepository(value: string): [string, string] {
  const parts = value.trim().split("/");
  const safe = (part: string | undefined) =>
    typeof part === "string" &&
    part.length > 0 &&
    part.length <= 100 &&
    /^[A-Za-z0-9._-]+$/.test(part);
  if (parts.length !== 2 || !safe(parts[0]) || !safe(parts[1])) {
    throw new GitHubSyncError(
      "Write the private repository as OWNER/NAME.",
      "configuration",
    );
  }
  return [parts[0]!, parts[1]!];
}

function repositoryUrl(owner: string, repository: string, ...suffix: string[]): URL {
  const segments = ["repos", owner, repository, ...suffix].map(encodeURIComponent);
  return new URL(`/${segments.join("/")}`, API_ROOT);
}

function contentsUrl(remote: GitHubRemote, path: string): URL {
  return repositoryUrl(
    remote.owner,
    remote.repository,
    "contents",
    ...path.split("/"),
  );
}

function collectProtocolEntries(entries: TreeEntry[], prefix: string): ProtocolTree {
  const protocol: ProtocolTree = { blobs: new Map() };
  for (const entry of entries) {
    const path = joinPath(prefix, entry.path);
    validateReservedDirectory(path, entry);
    if (path.startsWith("sync/v1/") && entry.type !== "tree") {
      insertProtocolBlob(protocol, path, entry);
    }
  }
  return protocol;
}

function insertProtocolBlob(
  protocol: ProtocolTree,
  path: string,
  entry: TreeEntry,
): void {
  if (entry.type !== "blob" || entry.mode !== "100644") {
    throw new GitHubSyncError(
      "A synchronization entry is not an ordinary immutable file.",
      "integrity",
    );
  }
  validateGitSha(entry.sha);
  if (protocol.blobs.has(path)) {
    throw new GitHubSyncError(
      "A synchronization path appears more than once in the repository.",
      "integrity",
    );
  }
  protocol.blobs.set(path, entry.sha);
}

function validateReservedDirectory(path: string, entry: TreeEntry): void {
  if ((path === "sync" || path === "sync/v1") && entry.type !== "tree") {
    throw new GitHubSyncError(
      "The reserved synchronization path is not a directory.",
      "integrity",
    );
  }
}

function protocolTreeRelevant(path: string): boolean {
  return path === "sync" || path === "sync/v1" || path.startsWith("sync/v1/");
}

function joinPath(prefix: string, path: string): string {
  return prefix.length === 0 ? path : `${prefix}/${path}`;
}

function validateGitSha(sha: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new GitHubSyncError(
      "GitHub returned an invalid object identity.",
      "integrity",
    );
  }
}

function base64ToBytes(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new GitHubSyncError(
      "GitHub returned invalid Base64 synchronization data.",
      "integrity",
    );
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GitHubSyncError(
      "GitHub returned a malformed API response.",
      "github_api",
    );
  }
}

function apiError(response: Response): GitHubSyncError {
  const status = response.status;
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.has("retry-after")));
  const kind =
    status === 401
      ? "authentication"
      : rateLimited
        ? "rate_limited"
        : status === 403
          ? "authorization"
          : status === 404
            ? "not_found"
            : status >= 500
              ? "server"
              : "github_api";
  const message =
    kind === "authentication"
      ? "GitHub rejected this token. Your queued changes remain safely stored here."
      : kind === "authorization"
        ? "This token cannot read and write the selected private repository."
        : kind === "rate_limited"
          ? "GitHub rate-limited synchronization. Your queued changes will retry later."
          : kind === "not_found"
            ? "GitHub could not find that repository or branch for this token."
            : kind === "server"
              ? "GitHub is temporarily unavailable. Your queued changes remain stored here."
              : `GitHub rejected the synchronization request (HTTP ${status}).`;
  return new GitHubSyncError(message, kind, retryAfterSeconds(response));
}

function retryAfterSeconds(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number.parseInt(retryAfter, 10);
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const resetSeconds = Number.parseInt(reset, 10);
    return Math.max(0, resetSeconds - Math.floor(Date.now() / 1_000));
  }
  return null;
}
