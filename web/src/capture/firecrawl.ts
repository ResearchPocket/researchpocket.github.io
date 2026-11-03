import registry from "../assistant/providers.json" with { type: "json" };

/**
 * The narrow Firecrawl REST calls the owner app makes, with the same scrape
 * request as the native CLI. Only the saved URL and the owner's key leave the
 * browser; normalization and size limits are the domain core's, applied when
 * the Markdown becomes a captured document.
 */

/** The reviewed origin; the owner app's CSP allows exactly this one. */
export const FIRECRAWL_ORIGIN = registry.captureOrigins[0] as string;
export const FIRECRAWL_KEY_URL = "https://www.firecrawl.dev/app/api-keys";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SCRAPE_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 15_000;

export class FirecrawlError extends Error {}

async function call(path: string, apiKey: string, init: RequestInit, timeoutMs: number) {
  let response: Response;
  try {
    response = await fetch(`${FIRECRAWL_ORIGIN}${path}`, {
      ...init,
      headers: { ...init.headers, Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new FirecrawlError(
      (cause as Error).name === "TimeoutError"
        ? "Firecrawl did not answer in time. Try again."
        : "Firecrawl could not be reached. Check your connection and try again.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new FirecrawlError("Firecrawl rejected the key. Check it in Settings → Assistant.");
  }
  if (response.status === 402) throw new FirecrawlError("Your Firecrawl credits are used up.");
  if (response.status === 429) throw new FirecrawlError("Firecrawl is rate limiting requests. Try again shortly.");
  if (!response.ok) throw new FirecrawlError("Firecrawl could not capture this page.");
  return boundedJson(response);
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new FirecrawlError("The captured page is too large to keep.");
  const reader = response.body?.getReader();
  if (!reader) throw new FirecrawlError("Firecrawl returned an empty response.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new FirecrawlError("The captured page is too large to keep.");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new FirecrawlError("Firecrawl returned an unreadable response.");
  }
}

/** Confirms the key without spending a credit, and reports what is left. */
export async function checkFirecrawlKey(apiKey: string): Promise<number | null> {
  const payload = (await call("/v2/team/credit-usage", apiKey, { method: "GET" }, CHECK_TIMEOUT_MS)) as {
    data?: { remainingCredits?: unknown };
  };
  const remaining = payload.data?.remainingCredits;
  return typeof remaining === "number" && Number.isFinite(remaining) ? remaining : null;
}

/** Scrapes the whole page as Markdown, exactly as `research enrich` does. */
export async function scrapeMarkdown(apiKey: string, url: string): Promise<string> {
  const target = new URL(url);
  target.hash = "";
  const payload = (await call(
    "/v2/scrape",
    apiKey,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: target.href,
        formats: ["markdown"],
        onlyMainContent: false,
        skipTlsVerification: false,
        timeout: 30_000,
        proxy: "basic",
        storeInCache: false,
      }),
    },
    SCRAPE_TIMEOUT_MS,
  )) as { success?: unknown; data?: { markdown?: unknown } };
  const markdown = payload.success === true ? payload.data?.markdown : undefined;
  if (typeof markdown !== "string" || !markdown.trim()) {
    throw new FirecrawlError("Firecrawl found no readable content on this page.");
  }
  return markdown;
}
