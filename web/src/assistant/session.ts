import {
  forgetAssistant,
  readAssistant,
  writeAssistant,
  type AssistantKeyBinding,
  type AssistantSettings,
} from "../data/credentials.ts";
import { profileStorageNames } from "../data/profiles.ts";
import type { Connection } from "./client.ts";
import { findPreset, resolveBaseUrl, type ProviderPreset } from "./presets.ts";

export type AssistantStatus = "loading" | "off" | "locked" | "ready";

export interface AssistantSnapshot {
  status: AssistantStatus;
  settings: AssistantSettings | null;
  preset: ProviderPreset | null;
  baseURL: string | null;
  /** A key is available in this tab, whether typed or restored. */
  keyAvailable: boolean;
  keyRemembered: boolean;
}

export interface AssistantDraft {
  provider: string;
  model: string;
  localBaseUrl: string | null;
  /** Empty keeps the key this tab already holds for the same provider. */
  apiKey: string;
  remember: boolean;
}

let client: Promise<typeof import("./client.ts")> | null = null;

/** The SDK and provider adapters download only when the owner uses them. */
export function loadAssistantClient() {
  client ??= import("./client.ts");
  return client;
}

function bindingFor(settings: Pick<AssistantSettings, "provider" | "localBaseUrl">): AssistantKeyBinding | null {
  const preset = findPreset(settings.provider);
  if (!preset) return null;
  try {
    return { provider: preset.id, baseURL: resolveBaseUrl(preset, settings.localBaseUrl) };
  } catch {
    return null;
  }
}

const LOADING: AssistantSnapshot = {
  status: "loading",
  settings: null,
  preset: null,
  baseURL: null,
  keyAvailable: false,
  keyRemembered: false,
};

/**
 * Per-library assistant state. Settings and an opted-in key live in the
 * profile's local-only credential database; otherwise the key exists only in
 * this tab's memory. Nothing here touches the library replica or sync.
 */
class AssistantSession {
  private snapshot = LOADING;
  private listeners = new Set<() => void>();
  private apiKey: string | null = null;
  private keyBinding: AssistantKeyBinding | null = null;
  private revision = 0;
  private database: string | null = null;
  private channel: BroadcastChannel | null = null;
  private generation = 0;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  async open(namespace: string) {
    const generation = ++this.generation;
    this.channel?.close();
    this.apiKey = null;
    this.keyBinding = null;
    this.database = profileStorageNames(namespace).credentialDatabase;
    this.emit(LOADING);
    const channel = new BroadcastChannel(`${namespace}-assistant`);
    channel.onmessage = (event: MessageEvent<{ type?: unknown }>) => {
      if (event.data?.type === "forget") this.dropKey();
      void this.reload(generation);
    };
    this.channel = channel;
    await this.reload(generation);
  }

  connection(): Connection | null {
    const { status, settings, preset, baseURL } = this.snapshot;
    if (status !== "ready" || !settings || !preset || !baseURL) return null;
    return { preset, baseURL, apiKey: this.apiKey, model: settings.model };
  }

  /** Saves a tested configuration; the key stays in memory unless remembered. */
  async save(draft: AssistantDraft) {
    const binding = bindingFor(draft);
    const preset = findPreset(draft.provider);
    if (!binding || !preset) throw new Error("Choose a provider.");
    const apiKey = this.keyFor(draft, binding);
    const previous = this.snapshot.settings;
    const settings: AssistantSettings = {
      version: 1,
      provider: preset.id,
      model: draft.model.trim(),
      localBaseUrl: preset.origin === null ? binding.baseURL : null,
      disclosed: previous?.provider === preset.id && previous.disclosed,
    };
    await this.write(settings, draft.remember && apiKey ? { binding, apiKey } : null);
    this.apiKey = apiKey;
    this.keyBinding = apiKey ? binding : null;
    this.publish(settings, draft.remember && apiKey !== null);
    this.broadcast("changed");
  }

  /** The key the draft would use: newly typed, or the one this tab holds. */
  keyFor(draft: Pick<AssistantDraft, "provider" | "localBaseUrl" | "apiKey">, binding = bindingFor(draft)) {
    const typed = draft.apiKey.trim();
    if (typed) return typed;
    const sameTarget = binding && this.keyBinding &&
      binding.provider === this.keyBinding.provider && binding.baseURL === this.keyBinding.baseURL;
    return sameTarget ? this.apiKey : null;
  }

  async unlock(apiKey: string, remember: boolean) {
    const settings = this.snapshot.settings;
    const binding = settings ? bindingFor(settings) : null;
    if (!settings || !binding || !apiKey.trim()) return;
    if (remember) await this.write(settings, { binding, apiKey: apiKey.trim() });
    this.apiKey = apiKey.trim();
    this.keyBinding = binding;
    this.publish(settings, remember);
  }

  async setRemembered(remember: boolean) {
    const settings = this.snapshot.settings;
    const binding = settings ? bindingFor(settings) : null;
    if (!settings || !binding) return;
    await this.write(settings, remember && this.apiKey ? { binding, apiKey: this.apiKey } : null);
    this.publish(settings, remember && this.apiKey !== null);
  }

  /** Records that the owner has seen where this provider's requests go. */
  async acknowledgeDisclosure() {
    const settings = this.snapshot.settings;
    const binding = settings ? bindingFor(settings) : null;
    if (!settings || !binding || settings.disclosed) return;
    const next = { ...settings, disclosed: true };
    const keep = this.snapshot.keyRemembered && this.apiKey ? { binding, apiKey: this.apiKey } : null;
    await this.write(next, keep);
    this.publish(next, keep !== null);
  }

  async forgetKey() {
    if (!this.database) return;
    this.revision = await forgetAssistant(this.database, false);
    this.dropKey();
    this.publish(this.snapshot.settings, false);
    this.broadcast("forget");
  }

  async turnOff() {
    if (!this.database) return;
    this.revision = await forgetAssistant(this.database, true);
    this.dropKey();
    this.publish(null, false);
    this.broadcast("forget");
  }

  private async write(settings: AssistantSettings, remember: { binding: AssistantKeyBinding; apiKey: string } | null) {
    if (!this.database) throw new Error("The library is still opening.");
    const result = await writeAssistant(this.database, settings, remember, this.revision);
    this.revision = result.revision;
    if (remember && !result.remembered) {
      throw new Error("The key was forgotten in another tab. Enter it again to remember it.");
    }
  }

  private async reload(generation: number) {
    if (!this.database) return;
    const record = await readAssistant(this.database, bindingFor);
    if (generation !== this.generation) return;
    this.revision = record.revision;
    if (!record.settings) this.dropKey();
    if (record.apiKey && record.settings) {
      this.apiKey = record.apiKey;
      this.keyBinding = bindingFor(record.settings);
    }
    this.publish(record.settings, record.apiKey !== null);
  }

  private dropKey() {
    this.apiKey = null;
    this.keyBinding = null;
  }

  private publish(settings: AssistantSettings | null, keyRemembered: boolean) {
    const preset = settings ? findPreset(settings.provider) : null;
    const binding = settings ? bindingFor(settings) : null;
    const keyMatches = Boolean(
      binding && this.keyBinding &&
      binding.provider === this.keyBinding.provider && binding.baseURL === this.keyBinding.baseURL,
    );
    if (!keyMatches) this.dropKey();
    const keyAvailable = this.apiKey !== null;
    const status: AssistantStatus =
      !settings || !preset || !binding || !settings.model
        ? "off"
        : preset.keyRequired && !keyAvailable
          ? "locked"
          : "ready";
    this.emit({
      status,
      settings: status === "off" ? null : settings,
      preset: status === "off" ? null : preset,
      baseURL: binding?.baseURL ?? null,
      keyAvailable,
      keyRemembered: keyRemembered && keyAvailable,
    });
  }

  private emit(snapshot: AssistantSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private broadcast(type: "changed" | "forget") {
    this.channel?.postMessage({ type });
  }
}

export const assistantSession = new AssistantSession();
