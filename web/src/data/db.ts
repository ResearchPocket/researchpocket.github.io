import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export interface PersistedLibraryMeta {
  key: "library";
  libraryId: string;
  deviceId: string;
  peerId: string;
  nextSequence: string;
  createdAt: string;
}

export interface PersistedSnapshot {
  key: "canonical";
  snapshot: string;
  updatedAt: string;
}

export interface PersistedItem {
  id: string;
  url: string;
  title: string | null;
  excerpt: string | null;
  note: string | null;
  favorite: boolean;
  language: string | null;
  savedAt: string;
  savedAtUnix: number;
  capturedDocument: CapturedDocumentReference | null;
  tags: string[];
  deleted: boolean;
}

export interface CapturedDocumentReference {
  sha256: string;
  byte_length: number;
  media_type: string;
  provenance: {
    provider: string;
    source_url: string;
    captured_at: string;
  };
}

export interface PersistedCapturedDocument {
  sha256: string;
  path: string;
  markdown: string;
  byteLength: number;
  storedAt: string;
}

export interface PersistedBatch {
  path: string;
  libraryId: string;
  deviceId: string;
  sequence: string;
  payloadSha256: string;
  envelopeJson: string;
  origin: "local" | "remote";
  appliedAt: string;
}

export type PersistedChangeKind = "create" | "edit" | "delete" | "restore";

export type PersistedChangeField =
  | "url"
  | "title"
  | "excerpt"
  | "note"
  | "language";

export interface PersistedChangeSummary {
  version: 1;
  kind: PersistedChangeKind;
  itemId: string;
  fields: PersistedChangeField[];
  favorite: boolean | null;
  addedTags: string[];
  removedTags: string[];
}

export interface PersistedOutbox {
  path: string;
  enqueuedAt: string;
  attempts: number;
  lastErrorKind: string | null;
  summary?: PersistedChangeSummary;
}

export interface PersistedDeferred {
  path: string;
  envelopeJson: string;
}

export interface RemoteObservation {
  path: string;
  blobSha: string;
  observedAt: string;
}

export interface PersistedCoverageInterval {
  start: string;
  end: string;
}

export type PersistedCheckpointCoverage = Record<
  string,
  PersistedCoverageInterval[]
>;

export interface PersistedCheckpoint {
  path: string;
  checkpointId: string;
  checkpointJson: string;
  batchCount: number;
  coverage: PersistedCheckpointCoverage;
  createdAt: string;
  origin: "local" | "remote";
  appliedAt: string;
}

export interface PersistedSelectedCheckpoint {
  key: "selected";
  checkpointPath: string;
  selectedAt: string;
}

export interface PersistedSyncConfiguration {
  key: "github";
  owner: string;
  repository: string;
  branch: string;
  connectedAt: string;
  lastSuccessAt: string | null;
  lastErrorKind: string | null;
  lastErrorAt: string | null;
}

interface ResearchPocketBrowserDb extends DBSchema {
  meta: {
    key: "library";
    value: PersistedLibraryMeta;
  };
  state: {
    key: "canonical";
    value: PersistedSnapshot;
  };
  items: {
    key: string;
    value: PersistedItem;
    indexes: {
      "by-saved-at": [number, string];
    };
  };
  batches: {
    key: string;
    value: PersistedBatch;
    indexes: {
      "by-device-sequence": [string, string];
    };
  };
  outbox: {
    key: string;
    value: PersistedOutbox;
  };
  deferred: {
    key: string;
    value: PersistedDeferred;
  };
  remoteObservations: {
    key: string;
    value: RemoteObservation;
  };
  checkpoints: {
    key: string;
    value: PersistedCheckpoint;
  };
  selectedCheckpoint: {
    key: "selected";
    value: PersistedSelectedCheckpoint;
  };
  capturedDocuments: {
    key: string;
    value: PersistedCapturedDocument;
  };
  syncConfig: {
    key: "github";
    value: PersistedSyncConfiguration;
  };
}

export function openBrowserDatabase(
  name: string,
): Promise<IDBPDatabase<ResearchPocketBrowserDb>> {
  return openDB<ResearchPocketBrowserDb>(name, 4, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore("meta", { keyPath: "key" });
        database.createObjectStore("state", { keyPath: "key" });

        const items = database.createObjectStore("items", { keyPath: "id" });
        items.createIndex("by-saved-at", ["savedAtUnix", "id"]);

        const batches = database.createObjectStore("batches", { keyPath: "path" });
        batches.createIndex("by-device-sequence", ["deviceId", "sequence"], {
          unique: true,
        });
        database.createObjectStore("outbox", { keyPath: "path" });
        database.createObjectStore("deferred", { keyPath: "path" });
        database.createObjectStore("remoteObservations", { keyPath: "path" });
      }
      if (oldVersion < 2) {
        database.createObjectStore("syncConfig", { keyPath: "key" });
      }
      if (oldVersion < 3) {
        database.createObjectStore("checkpoints", { keyPath: "path" });
        database.createObjectStore("selectedCheckpoint", { keyPath: "key" });
      }
      if (oldVersion < 4) {
        database.createObjectStore("capturedDocuments", { keyPath: "sha256" });
      }
    },
    blocked() {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("researchpocket:database-blocked"));
      }
    },
  });
}

export type BrowserDatabase = IDBPDatabase<ResearchPocketBrowserDb>;
