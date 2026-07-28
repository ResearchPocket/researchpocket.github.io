import initWasm, {
  applyMutation,
  applyRemoteEnvelopes,
  createCheckpoint,
  createCapturedDocument,
  createOperationPack,
  createSyncGenesis,
  initializeLibrary,
  materializeLibrary,
  unpackOperationPack,
  validateCheckpoint,
  validateCapturedContent,
  validateSyncGenesis,
} from "../generated/research_domain";

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

interface DomainRequest {
  id: number;
  method: DomainMethod;
  args: string[];
}

interface DomainResponse {
  id: number;
  result?: string;
  error?: string;
}

const methods: Record<DomainMethod, (...args: string[]) => string> = {
  applyMutation,
  applyRemoteEnvelopes,
  createCheckpoint,
  createCapturedDocument,
  createOperationPack,
  createSyncGenesis,
  initializeLibrary,
  materializeLibrary,
  unpackOperationPack,
  validateCheckpoint,
  validateCapturedContent,
  validateSyncGenesis,
};

const ready = initWasm();

self.addEventListener("message", (event: MessageEvent<DomainRequest>) => {
  void handle(event.data);
});

async function handle(request: DomainRequest): Promise<void> {
  const response: DomainResponse = { id: request.id };
  try {
    await ready;
    const method = methods[request.method];
    response.result = method(...request.args);
  } catch (error) {
    response.error = error instanceof Error ? error.message : String(error);
  }
  self.postMessage(response);
}
