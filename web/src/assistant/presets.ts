import registry from "./providers.json" with { type: "json" };

export type ProviderApi = "openai" | "anthropic" | "google" | "openai-compatible";

export interface ProviderPreset {
  id: string;
  label: string;
  api: ProviderApi;
  /** The reviewed CSP origin; null for loopback servers. */
  origin: string | null;
  baseURL: string;
  keyUrl: string | null;
  keyRequired: boolean;
}

export const PROVIDER_PRESETS = registry.providers as ProviderPreset[];
export const LOOPBACK_CONNECT_SOURCES = registry.loopbackSources;

export function findPreset(id: string): ProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isLocalPreset(preset: ProviderPreset) {
  return preset.origin === null;
}

/**
 * The page's CSP cannot widen at runtime, so a base URL the owner types is
 * accepted only where the CSP already allows it: plain HTTP on loopback.
 * Anything else has to go through a local gateway on loopback.
 */
export function normalizeLocalBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a full address such as http://localhost:11434/v1.");
  }
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) {
    throw new Error(
      "Local servers must use http://localhost or http://127.0.0.1. Reach other hosts through a local gateway.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Remove credentials, query strings, and fragments from the address.");
  }
  return url.href.replace(/\/+$/u, "");
}

/** The base URL a configured provider uses; hosted presets are fixed. */
export function resolveBaseUrl(preset: ProviderPreset, localBaseUrl: string | null) {
  return isLocalPreset(preset)
    ? normalizeLocalBaseUrl(localBaseUrl ?? preset.baseURL)
    : preset.baseURL;
}
