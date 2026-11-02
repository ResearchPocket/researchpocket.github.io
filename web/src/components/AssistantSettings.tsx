import { useEffect, useId, useState, useSyncExternalStore, type SubmitEvent } from "react";

import {
  PROVIDER_PRESETS,
  findPreset,
  isLocalPreset,
  normalizeLocalBaseUrl,
} from "../assistant/presets.ts";
import { assistantSession, loadAssistantClient } from "../assistant/session.ts";

const HOSTED = PROVIDER_PRESETS.filter((preset) => !isLocalPreset(preset));
const LOCAL = PROVIDER_PRESETS.filter(isLocalPreset);

type Check =
  | { state: "idle" }
  | { state: "working"; message: string }
  | { state: "ok"; message: string }
  | { state: "error"; message: string; canSaveAnyway: boolean };

/**
 * Bring-your-own-key setup. Nothing is sent anywhere until the owner tests a
 * connection, and every later request is one they start from a save.
 */
export function AssistantSettings() {
  const snapshot = useSyncExternalStore(assistantSession.subscribe, assistantSession.getSnapshot);
  const [editing, setEditing] = useState(false);
  const configured = snapshot.status === "ready" || snapshot.status === "locked";

  return (
    <div className="settings-group" id="assistant-settings">
      <div>
        <h3>Assistant</h3>
        <p>
          Use your own model key to suggest tags and draft summaries for a save. Requests go
          straight from this browser to the provider you choose, only when you ask.
        </p>
      </div>
      <div className="assistant-settings">
        {snapshot.status === "loading" ? (
          <p className="settings-status" role="status">Loading assistant settings…</p>
        ) : configured && !editing ? (
          <AssistantSummary onChange={() => setEditing(true)} />
        ) : (
          <AssistantForm
            onCancel={configured ? () => setEditing(false) : null}
            onSaved={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}

function AssistantSummary({ onChange }: { onChange: () => void }) {
  const snapshot = useSyncExternalStore(assistantSession.subscribe, assistantSession.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preset = snapshot.preset!;
  const settings = snapshot.settings!;
  const local = isLocalPreset(preset);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="settings-status assistant-status" role="status">
        <span aria-hidden="true" className={`status-dot${snapshot.status === "ready" ? "" : " status-dot-warning"}`} />
        {snapshot.status === "ready" ? "Ready" : "Key needed for this tab"}
      </p>
      <dl className="assistant-facts">
        <div><dt>Provider</dt><dd>{preset.label}</dd></div>
        <div><dt>Model</dt><dd><code>{settings.model}</code></dd></div>
        <div><dt>Address</dt><dd><code>{snapshot.baseURL}</code></dd></div>
        <div>
          <dt>Key</dt>
          <dd>
            {!preset.keyRequired && !snapshot.keyAvailable
              ? "Not needed"
              : snapshot.keyRemembered
                ? "Remembered in this browser"
                : snapshot.keyAvailable
                  ? "Kept in memory for this tab"
                  : "Not entered"}
          </dd>
        </div>
      </dl>

      {snapshot.status === "locked" ? (
        <UnlockForm busy={busy} label={preset.label} onUnlock={(key, remember) => run(() => assistantSession.unlock(key, remember))} />
      ) : snapshot.keyAvailable ? (
        <>
          <label className="check-field">
            <input
              aria-describedby="assistant-remember-help"
              checked={snapshot.keyRemembered}
              disabled={busy}
              onChange={(event) => void run(() => assistantSession.setRemembered(event.target.checked))}
              type="checkbox"
            />
            <span>Remember key in this browser</span>
          </label>
          <p className="sync-help" id="assistant-remember-help">
            {snapshot.keyRemembered
              ? "Saved for this library in this browser only. It is never synced or exported."
              : "Only remember it in a browser you trust—anyone with access to this browser profile could use it."}
          </p>
        </>
      ) : null}

      {error ? <p className="sync-error" role="alert">{error}</p> : null}

      <div className="assistant-buttons">
        <button className="secondary-button" disabled={busy} onClick={onChange} type="button">
          Change provider or model
        </button>
        {snapshot.keyAvailable && preset.keyRequired ? (
          <button className="secondary-button" disabled={busy} onClick={() => void run(() => assistantSession.forgetKey())} type="button">
            Forget key
          </button>
        ) : null}
        <button className="text-button" disabled={busy} onClick={() => void run(() => assistantSession.turnOff())} type="button">
          Turn off assistant
        </button>
      </div>
      <p className="sync-help">
        {local
          ? "Requests stay on this computer. Your library, sync, and exports never include assistant settings."
          : `Forgetting the key here does not revoke it with ${preset.label}. Your library, sync, and exports never include it.`}
      </p>
    </>
  );
}

function UnlockForm({ busy, label, onUnlock }: {
  busy: boolean;
  label: string;
  onUnlock: (key: string, remember: boolean) => Promise<void>;
}) {
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const key = String(data.get("assistant-unlock-key") ?? "");
    const remember = data.get("assistant-unlock-remember") === "on";
    form.reset();
    void onUnlock(key, remember);
  }

  return (
    <form className="assistant-form" onSubmit={submit}>
      <label className="field">
        <span>{label} key</span>
        <input autoCapitalize="none" autoComplete="off" name="assistant-unlock-key" required spellCheck={false} type="password" />
      </label>
      <label className="check-field">
        <input name="assistant-unlock-remember" type="checkbox" />
        <span>Remember key in this browser</span>
      </label>
      <button className="primary-button" disabled={busy} type="submit">Use key</button>
    </form>
  );
}

function AssistantForm({ onCancel, onSaved }: { onCancel: (() => void) | null; onSaved: () => void }) {
  const snapshot = useSyncExternalStore(assistantSession.subscribe, assistantSession.getSnapshot);
  const id = useId();
  const [provider, setProvider] = useState(snapshot.settings?.provider ?? "");
  const [localBaseUrl, setLocalBaseUrl] = useState(snapshot.settings?.localBaseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(snapshot.settings?.model ?? "");
  const [remember, setRemember] = useState(snapshot.keyRemembered);
  const [models, setModels] = useState<string[]>([]);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const preset = findPreset(provider);
  const local = preset ? isLocalPreset(preset) : false;
  const heldKey = preset ? assistantSession.keyFor({ provider, localBaseUrl: local ? localBaseUrl : null, apiKey: "" }) : null;
  const working = check.state === "working";

  useEffect(() => {
    setModels([]);
    setCheck({ state: "idle" });
  }, [provider, localBaseUrl]);

  function chooseProvider(next: string) {
    setProvider(next);
    const nextPreset = findPreset(next);
    setLocalBaseUrl(nextPreset && isLocalPreset(nextPreset) ? nextPreset.baseURL : "");
    if (next !== snapshot.settings?.provider) setModel("");
    else setModel(snapshot.settings.model);
  }

  function draftConnection() {
    if (!preset) throw new Error("Choose a provider.");
    const baseURL = local ? normalizeLocalBaseUrl(localBaseUrl) : preset.baseURL;
    const key = assistantSession.keyFor({ provider, localBaseUrl: local ? baseURL : null, apiKey });
    if (preset.keyRequired && !key) throw new Error(`Enter your ${preset.label} key.`);
    return { preset, baseURL, apiKey: key, model: model.trim() };
  }

  async function loadModels() {
    try {
      const connection = draftConnection();
      setCheck({ state: "working", message: `Loading models from ${preset!.label}…` });
      const client = await loadAssistantClient();
      const ids = await client.listModels(connection);
      setModels(ids);
      if (!model.trim() && ids[0]) setModel(ids[0]);
      setCheck(
        ids.length > 0
          ? { state: "ok", message: `${ids.length} models available. Pick one below.` }
          : { state: "error", message: "The provider listed no chat models. Type a model ID instead.", canSaveAnyway: false },
      );
    } catch (cause) {
      setCheck({ state: "error", message: cause instanceof Error ? cause.message : "Models could not be loaded.", canSaveAnyway: false });
    }
  }

  async function save(skipTest: boolean) {
    try {
      const connection = draftConnection();
      if (!connection.model) throw new Error("Choose or type a model.");
      if (!skipTest) {
        setCheck({ state: "working", message: `Testing ${connection.preset.label} with ${connection.model}…` });
        const client = await loadAssistantClient();
        const result = await client.testConnection(connection);
        setCheck({ state: "ok", message: `Connected in ${(result.milliseconds / 1000).toFixed(1)} s.` });
      }
      await assistantSession.save({
        provider,
        model: connection.model,
        localBaseUrl: local ? connection.baseURL : null,
        apiKey,
        remember,
      });
      setApiKey("");
      onSaved();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The connection could not be saved.";
      const category = (cause as { category?: string }).category;
      setCheck({ state: "error", message, canSaveAnyway: !skipTest && (category === "network" || category === "rate" || category === "provider") });
    }
  }

  return (
    <form
      className="assistant-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save(false);
      }}
    >
      <fieldset className="assistant-inputs" disabled={working}>
        <label className="field">
          <span>Provider</span>
          <select onChange={(event) => chooseProvider(event.target.value)} required value={provider}>
            <option disabled value="">Choose a provider</option>
            <optgroup label="Hosted with your key">
              {HOSTED.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </optgroup>
            <optgroup label="Running on this computer">
              {LOCAL.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </optgroup>
          </select>
        </label>

        {preset && local ? (
          <label className="field">
            <span>Server address <small>http://localhost or http://127.0.0.1</small></span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              inputMode="url"
              onChange={(event) => setLocalBaseUrl(event.target.value)}
              required
              spellCheck={false}
              value={localBaseUrl}
            />
            <small className="assistant-field-help">
              The server must allow requests from {window.location.origin}
              {preset.id === "ollama" ? <> — start Ollama with <code>OLLAMA_ORIGINS={window.location.origin}</code></> : null}
              {preset.id === "lmstudio" ? " — turn on CORS in LM Studio’s server settings" : null}.
              Other hosts can be reached through a local gateway such as LiteLLM.
            </small>
          </label>
        ) : null}

        {preset ? (
          <label className="field">
            <span>
              API key {preset.keyRequired ? null : <small>optional</small>}
              {preset.keyUrl ? <> · <a href={preset.keyUrl} rel="noreferrer" target="_blank">Get a {preset.label} key</a></> : null}
            </span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={heldKey ? "Using the key already entered in this tab" : undefined}
              required={preset.keyRequired && !heldKey}
              spellCheck={false}
              type="password"
              value={apiKey}
            />
          </label>
        ) : null}

        {preset ? (
          <div className="field">
            <label className="field-caption" htmlFor={`${id}-model`}>
              Model <small>pick from the list or type an ID</small>
            </label>
            <div className="assistant-model-row">
              <input
                autoCapitalize="none"
                autoComplete="off"
                id={`${id}-model`}
                list={`${id}-models`}
                onChange={(event) => setModel(event.target.value)}
                required
                spellCheck={false}
                value={model}
              />
              <button className="secondary-button" onClick={() => void loadModels()} type="button">
                Load models
              </button>
            </div>
            <datalist id={`${id}-models`}>
              {models.map((option) => <option key={option} value={option} />)}
            </datalist>
          </div>
        ) : null}

        {preset && (preset.keyRequired || apiKey) ? (
          <>
            <label className="check-field">
              <input checked={remember} onChange={(event) => setRemember(event.target.checked)} type="checkbox" />
              <span>Remember key in this browser</span>
            </label>
            <p className="sync-help">
              Off by default: the key stays in this tab’s memory. Only remember it in a browser you
              trust—anyone with access to this browser profile could use it.
            </p>
          </>
        ) : null}

        {preset ? (
          <p className="assistant-disclosure">
            {local
              ? `Requests go to ${preset.label} on this computer.`
              : `Requests go directly from this browser to ${preset.label} (${preset.origin}) and are billed to your key.`}{" "}
            Each request is one you start from a save. Before it is sent you can see which fields it
            includes. Nothing is applied to your library until you accept it.
          </p>
        ) : null}
      </fieldset>

      {check.state !== "idle" ? (
        <p
          className={check.state === "error" ? "sync-error" : "sync-help"}
          role={check.state === "error" ? "alert" : "status"}
        >
          {check.message}
        </p>
      ) : null}

      <div className="assistant-buttons">
        <button className="primary-button" disabled={!preset || working} type="submit">
          {working ? "Working…" : "Test and save"}
        </button>
        {check.state === "error" && check.canSaveAnyway ? (
          <button className="secondary-button" onClick={() => void save(true)} type="button">
            Save without testing
          </button>
        ) : null}
        {onCancel ? (
          <button className="text-button" disabled={working} onClick={onCancel} type="button">
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
