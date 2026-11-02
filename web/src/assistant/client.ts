/**
 * The only module that talks to a model provider. It is loaded on demand, so
 * an owner who never turns the assistant on never downloads the SDK.
 *
 * Provider wire formats come from the maintained AI SDK packages; this file
 * only chooses the adapter, keeps requests private (no cookies, no referrer,
 * no cache), bounds time and output, and turns failures into owner language.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, RetryError, generateText, streamText, type LanguageModel } from "ai";

import type { ProviderPreset } from "./presets.ts";
import type { AssistantRequest } from "./prompts.ts";

export interface Connection {
  preset: ProviderPreset;
  baseURL: string;
  apiKey: string | null;
  model: string;
}

export type FailureCategory =
  | "auth"
  | "model"
  | "rate"
  | "quota"
  | "network"
  | "provider"
  | "request"
  | "cancelled";

export class AssistantError extends Error {
  readonly category: FailureCategory;
  constructor(category: FailureCategory, message: string) {
    super(message);
    this.category = category;
  }
}

const REQUEST_TIMEOUT_MS = 90_000;
const ANTHROPIC_VERSION = "2023-06-01";

const privateFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });

function languageModel({ preset, baseURL, apiKey, model }: Connection): LanguageModel {
  const key = apiKey ?? "";
  switch (preset.api) {
    case "openai":
      return createOpenAI({ apiKey: key, baseURL, fetch: privateFetch }).chat(model);
    case "anthropic":
      return createAnthropic({
        apiKey: key,
        baseURL,
        fetch: privateFetch,
        // Anthropic requires this explicit opt-in for calls made from a page.
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      })(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey: key, baseURL, fetch: privateFetch })(model);
    case "openai-compatible":
      return createOpenAICompatible({
        name: preset.id,
        baseURL,
        apiKey: apiKey ?? undefined,
        fetch: privateFetch,
      }).chatModel(model);
  }
}

/**
 * OpenAI rejects the legacy max_tokens on newer models, and the SDK only
 * switches to max_completion_tokens for model IDs it recognises. Every current
 * OpenAI chat model accepts max_completion_tokens, so OpenAI always gets that;
 * other providers keep the SDK's standard limit. `store: false` keeps OpenAI
 * from retaining the completion. Options are keyed by provider.
 */
function outputLimit(connection: Connection, tokens: number) {
  return connection.preset.api === "openai"
    ? { providerOptions: { openai: { maxCompletionTokens: tokens, store: false } } }
    : { maxOutputTokens: tokens };
}

function signalFor(signal: AbortSignal | undefined) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Provider error text is shown to the owner, so it is shortened and scrubbed. */
function providerDetail(error: APICallError) {
  let detail = "";
  const data = error.data as { error?: { message?: unknown } | string; message?: unknown } | undefined;
  if (typeof data?.error === "string") detail = data.error;
  else if (typeof data?.error?.message === "string") detail = data.error.message;
  else if (typeof data?.message === "string") detail = data.message;
  else if (error.responseBody) {
    try {
      const body = JSON.parse(error.responseBody) as { error?: { message?: string } | string; message?: string };
      detail = typeof body.error === "string" ? body.error : body.error?.message ?? body.message ?? "";
    } catch {
      detail = "";
    }
  }
  return detail
    .replace(/\b(?:sk|key|token|pat)[-_][\w-]{6,}/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

export function describeFailure(error: unknown, connection: Pick<Connection, "preset" | "baseURL">): AssistantError {
  if (error instanceof AssistantError) return error;
  const label = connection.preset.label;
  const cause = RetryError.isInstance(error) ? error.lastError : error;

  if (
    (cause instanceof DOMException && (cause.name === "AbortError" || cause.name === "TimeoutError")) ||
    (cause instanceof Error && cause.name === "AbortError")
  ) {
    return cause instanceof DOMException && cause.name === "TimeoutError"
      ? new AssistantError("network", `${label} did not answer in time. Try again, or pick a faster model.`)
      : new AssistantError("cancelled", "Request cancelled.");
  }

  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode ?? 0;
    const detail = providerDetail(cause);
    const suffix = detail ? ` ${label} said: “${detail}”` : "";
    if (status === 401 || status === 403) {
      return new AssistantError("auth", `${label} rejected the key. Check that it is correct and still active.${suffix}`);
    }
    if (status === 404) {
      return new AssistantError("model", `${label} does not recognise that model for this key. Choose another model.${suffix}`);
    }
    if (status === 402) {
      return new AssistantError("quota", `${label} reports no remaining credit or quota for this key.${suffix}`);
    }
    if (status === 429) {
      return new AssistantError("rate", `${label} is rate limiting requests. Wait a moment and try again.${suffix}`);
    }
    if (status >= 500) {
      return new AssistantError("provider", `${label} had a server error. Try again shortly.${suffix}`);
    }
    return new AssistantError("request", `${label} could not complete the request.${suffix}`);
  }

  if (cause instanceof TypeError) {
    if (connection.preset.origin === null) {
      return new AssistantError(
        "network",
        `Could not reach ${label} at ${connection.baseURL}. Check that it is running and allows requests from this site (for Ollama, set OLLAMA_ORIGINS).`,
      );
    }
    return new AssistantError(
      "network",
      connection.preset.id === "openai"
        ? "Could not reach OpenAI, or OpenAI refused without telling the browser why. It does this for an invalid key and some account errors: check the key, that your project can use this model, and your connection."
        : `Could not reach ${label}. Check your connection.`,
    );
  }

  return new AssistantError("request", cause instanceof Error ? cause.message.slice(0, 240) : "The assistant request failed.");
}

/** One short completion proves the key, model, and network path together. */
export async function testConnection(connection: Connection, signal?: AbortSignal) {
  const started = performance.now();
  try {
    const result = await generateText({
      model: languageModel(connection),
      prompt: "Reply with the single word OK.",
      // Reasoning models may spend a small budget before answering; any
      // accepted completion, even an empty one, proves the path works.
      ...outputLimit(connection, 256),
      maxRetries: 0,
      abortSignal: signalFor(signal),
    });
    return { milliseconds: Math.round(performance.now() - started), reply: result.text.trim().slice(0, 40) };
  } catch (error) {
    throw describeFailure(error, connection);
  }
}

export async function complete(connection: Connection, request: AssistantRequest, signal?: AbortSignal) {
  try {
    const result = await generateText({
      model: languageModel(connection),
      system: request.system,
      prompt: request.prompt,
      ...outputLimit(connection, 1_200),
      maxRetries: 1,
      abortSignal: signalFor(signal),
    });
    return result.text;
  } catch (error) {
    throw describeFailure(error, connection);
  }
}

export async function stream(
  connection: Connection,
  request: AssistantRequest,
  onText: (text: string) => void,
  signal?: AbortSignal,
) {
  let text = "";
  try {
    const result = streamText({
      model: languageModel(connection),
      system: request.system,
      prompt: request.prompt,
      ...outputLimit(connection, 1_200),
      maxRetries: 1,
      abortSignal: signalFor(signal),
    });
    for await (const part of result.stream) {
      if (part.type === "text-delta") {
        text += part.text;
        onText(text);
      } else if (part.type === "error") {
        throw part.error;
      }
    }
    return text;
  } catch (error) {
    throw describeFailure(error, connection);
  }
}

const NON_CHAT_MODEL = /embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|audio|realtime|image|search|rerank|guard|computer-use/iu;

/** Lists models when the provider exposes them; the owner can still type one. */
export async function listModels(connection: Omit<Connection, "model">, signal?: AbortSignal): Promise<string[]> {
  const { preset, baseURL, apiKey } = connection;
  const headers: Record<string, string> = {};
  let url = `${baseURL}/models`;
  if (preset.api === "anthropic") {
    url += "?limit=1000";
    headers["x-api-key"] = apiKey ?? "";
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (preset.api === "google") {
    url += "?pageSize=1000";
    headers["x-goog-api-key"] = apiKey ?? "";
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await privateFetch(url, { headers, signal: signalFor(signal) });
  } catch (error) {
    throw describeFailure(error, { preset, baseURL });
  }
  if (!response.ok) {
    throw describeFailure(
      new APICallError({
        message: response.statusText,
        url,
        requestBodyValues: {},
        statusCode: response.status,
        responseBody: await response.text().catch(() => ""),
      }),
      { preset, baseURL },
    );
  }

  const body = (await response.json()) as {
    data?: { id?: unknown }[];
    models?: { name?: unknown; supportedGenerationMethods?: unknown }[];
  };
  const ids =
    preset.api === "google"
      ? (body.models ?? [])
          .filter((model) =>
            Array.isArray(model.supportedGenerationMethods) &&
            model.supportedGenerationMethods.includes("generateContent"))
          .map((model) => String(model.name ?? "").replace(/^models\//u, ""))
      : (body.data ?? []).map((model) => String(model.id ?? ""));
  return [...new Set(ids.filter((id) => id && !NON_CHAT_MODEL.test(id)))].sort((left, right) =>
    left.localeCompare(right),
  );
}
