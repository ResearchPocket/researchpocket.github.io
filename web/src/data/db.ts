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
  tags: string[];
  deleted: boolean;
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

export interface PersistedOutbox {
  path: string;
  enqueuedAt: string;
  attempts: number;
  lastErrorKind: string | null;
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
}

let databasePromise: Promise<IDBPDatabase<ResearchPocketBrowserDb>> | undefined;

export function browserDatabase(): Promise<IDBPDatabase<ResearchPocketBrowserDb>> {
  databasePromise ??= openBrowserDatabase("researchpocket-v2");
  return databasePromise;
}

export function openBrowserDatabase(
  name: string,
): Promise<IDBPDatabase<ResearchPocketBrowserDb>> {
  return openDB<ResearchPocketBrowserDb>(name, 1, {
    upgrade(database) {
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
    },
    blocked() {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("researchpocket:database-blocked"));
      }
    },
  });
}

export type BrowserDatabase = IDBPDatabase<ResearchPocketBrowserDb>;
