type DomainMethod =
  | "applyMutation"
  | "applyRemoteEnvelopes"
  | "createCheckpoint"
  | "createCapturedDocument"
  | "createOperationPack"
  | "createSyncGenesis"
  | "initializeLibrary"
  | "materializeLibrary"
  | "unpackOperationPack"
  | "validateCheckpoint"
  | "validateCapturedContent"
  | "validateSyncGenesis";

interface DomainResponse {
  id: number;
  result?: string;
  error?: string;
}

class BrowserDomainCore {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: string): void; reject(reason: Error): void }
  >();

  call(method: DomainMethod, ...args: string[]): Promise<string> {
    const worker = this.ensureWorker();
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./domain.worker.ts", import.meta.url), {
      type: "module",
      name: "researchpocket-domain",
    });
    worker.addEventListener("message", (event: MessageEvent<DomainResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (typeof response.error === "string") {
        pending.reject(new Error(response.error));
      } else if (typeof response.result === "string") {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error("The domain worker returned an invalid response."));
      }
    });
    worker.addEventListener("error", () => {
      const error = new Error(
        "The private library worker stopped before its operation completed.",
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
    });
    this.worker = worker;
    return worker;
  }
}

export const domainCore = new BrowserDomainCore();
