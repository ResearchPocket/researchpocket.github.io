import { readCapture, writeCapture, type CaptureSettings } from "../data/credentials.ts";
import { profileStorageNames } from "../data/profiles.ts";
import { checkFirecrawlKey } from "./firecrawl.ts";

export type CaptureStatus = "loading" | "off" | "locked" | "ready";

export interface CaptureSnapshot {
  status: CaptureStatus;
  captureOnSave: boolean;
  keyRemembered: boolean;
  /** Reported when the key was last checked in this tab. */
  remainingCredits: number | null;
}

const LOADING: CaptureSnapshot = {
  status: "loading",
  captureOnSave: false,
  keyRemembered: false,
  remainingCredits: null,
};

/**
 * Per-library Firecrawl state, kept like the assistant's: the key lives in
 * this tab's memory unless the owner chose to remember it, in the profile's
 * local-only credential database. Nothing here enters the library or sync.
 */
class CaptureSession {
  private snapshot = LOADING;
  private listeners = new Set<() => void>();
  private settings: CaptureSettings | null = null;
  private apiKey: string | null = null;
  private remembered = false;
  private remainingCredits: number | null = null;
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
    this.database = profileStorageNames(namespace).credentialDatabase;
    this.emit(LOADING);
    const channel = new BroadcastChannel(`${namespace}-capture`);
    channel.onmessage = (event: MessageEvent<{ type?: unknown }>) => {
      if (event.data?.type === "forget") this.apiKey = null;
      void this.reload(generation);
    };
    this.channel = channel;
    await this.reload(generation);
  }

  /** The key for a capture the owner asked for, when one is available. */
  key(): string | null {
    return this.snapshot.status === "ready" ? this.apiKey : null;
  }

  /** Checks the key with Firecrawl, then saves; the key stays in memory unless remembered. */
  async save(input: { apiKey: string; remember: boolean; captureOnSave: boolean }) {
    const apiKey = input.apiKey.trim() || this.apiKey;
    if (!apiKey) throw new Error("Enter your Firecrawl key.");
    this.remainingCredits = await checkFirecrawlKey(apiKey);
    const settings: CaptureSettings = { version: 1, captureOnSave: input.captureOnSave };
    await this.write(settings, input.remember ? apiKey : null);
    this.apiKey = apiKey;
    this.broadcast("changed");
  }

  async unlock(apiKey: string, remember: boolean) {
    if (!this.settings || !apiKey.trim()) return;
    this.remainingCredits = await checkFirecrawlKey(apiKey.trim());
    this.apiKey = apiKey.trim();
    await this.write(this.settings, remember ? this.apiKey : null);
  }

  async setCaptureOnSave(captureOnSave: boolean) {
    if (!this.settings) return;
    await this.write({ ...this.settings, captureOnSave }, this.remembered ? this.apiKey : null);
    this.broadcast("changed");
  }

  async setRemembered(remember: boolean) {
    if (!this.settings) return;
    await this.write(this.settings, remember ? this.apiKey : null);
  }

  async turnOff() {
    await this.write(null, null);
    this.apiKey = null;
    this.remainingCredits = null;
    this.publish();
    this.broadcast("forget");
  }

  private async write(settings: CaptureSettings | null, apiKey: string | null) {
    if (!this.database) throw new Error("The library is still opening.");
    const result = await writeCapture(this.database, settings, apiKey, this.revision);
    this.revision = result.revision;
    this.settings = settings;
    this.remembered = result.remembered;
    this.publish();
    if (apiKey && !result.remembered) {
      throw new Error("The key was forgotten in another tab. Enter it again to remember it.");
    }
  }

  private async reload(generation: number) {
    if (!this.database) return;
    const record = await readCapture(this.database);
    if (generation !== this.generation) return;
    this.revision = record.revision;
    this.settings = record.settings;
    this.remembered = record.apiKey !== null;
    if (record.apiKey) this.apiKey = record.apiKey;
    if (!record.settings) this.apiKey = null;
    this.publish();
  }

  private publish() {
    const keyAvailable = this.apiKey !== null;
    this.emit({
      status: !this.settings ? "off" : keyAvailable ? "ready" : "locked",
      captureOnSave: this.settings?.captureOnSave ?? false,
      keyRemembered: this.remembered && keyAvailable,
      remainingCredits: keyAvailable ? this.remainingCredits : null,
    });
  }

  private emit(snapshot: CaptureSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private broadcast(type: "changed" | "forget") {
    this.channel?.postMessage({ type });
  }
}

export const captureSession = new CaptureSession();
