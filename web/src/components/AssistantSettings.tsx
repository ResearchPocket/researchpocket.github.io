import { useEffect, useId, useState, useSyncExternalStore, type ReactNode, type SubmitEvent } from "react";

import {
  PROVIDER_PRESETS,
  findPreset,
  isLocalPreset,
  normalizeLocalBaseUrl,
} from "../assistant/presets.ts";
import type { ModelOption } from "../assistant/client.ts";
import { assistantSession, loadAssistantClient } from "../assistant/session.ts";
import { FIRECRAWL_KEY_URL } from "../capture/firecrawl.ts";
import { captureSession } from "../capture/session.ts";

const CUSTOM_MODEL = "__custom-model__";

function modelLabel(option: ModelOption) {
  const name = option.label !== option.id ? `${option.label} — ${option.id}` : option.id;
  return option.created ? `${name} · ${new Date(option.created).toISOString().slice(0, 10)}` : name;
}

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
        <PageCaptureSettings />
      </div>
    </div>
  );
}

/**
 * Firecrawl is the only page-capture service. Only the saved URL is sent, and
 * only when the owner captures a page or, if they keep it on, saves one.
 */
function PageCaptureSettings() {
  const snapshot = useSyncExternalStore(captureSession.subscribe, captureSession.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  if (snapshot.status === "loading") return null;
  const credits = snapshot.remainingCredits === null
    ? ""
    : ` · ${snapshot.remainingCredits.toLocaleString()} credits left`;

  return (
    <section aria-labelledby="page-capture-heading" className="page-capture-settings">
      <h4 id="page-capture-heading">Page capture</h4>
      {snapshot.status === "off" ? (
        <>
          <p className="sync-help">
            Only the saved URL is sent to Firecrawl.{" "}
            <a href={FIRECRAWL_KEY_URL} rel="noreferrer" target="_blank">Get a Firecrawl key</a>
          </p>
          <UnlockForm
            busy={busy}
            label="Firecrawl"
            onUnlock={(apiKey, remember, data) =>
              run(() => captureSession.save({ apiKey, remember, captureOnSave: data.get("capture-on-save") === "on" }))}
            submitLabel="Turn on"
          >
            <label className="check-field">
              <input defaultChecked name="capture-on-save" type="checkbox" />
              <span>Capture each new save</span>
            </label>
          </UnlockForm>
        </>
      ) : (
        <>
          <p className="settings-status assistant-status" role="status">
            <span aria-hidden="true" className={`status-dot${snapshot.status === "ready" ? "" : " status-dot-warning"}`} />
            {snapshot.status === "ready" ? `Ready${credits}` : "Key needed for this tab"}
          </p>
          {snapshot.status === "locked" ? (
            <UnlockForm busy={busy} label="Firecrawl" onUnlock={(apiKey, remember) => run(() => captureSession.unlock(apiKey, remember))} />
          ) : (
            <>
              <label className="check-field">
                <input
                  checked={snapshot.captureOnSave}
                  disabled={busy}
                  onChange={(event) => void run(() => captureSession.setCaptureOnSave(event.target.checked))}
                  type="checkbox"
                />
                <span>Capture each new save</span>
              </label>
              <label className="check-field">
                <input
                  checked={snapshot.keyRemembered}
                  disabled={busy}
                  onChange={(event) => void run(() => captureSession.setRemembered(event.target.checked))}
                  type="checkbox"
                />
                <span>Remember key in this browser</span>
              </label>
            </>
          )}
          <div className="assistant-buttons">
            <button className="text-button" disabled={busy} onClick={() => void run(() => captureSession.turnOff())} type="button">
              Turn off page capture
            </button>
          </div>
        </>
      )}
      {error ? <p className="sync-error" role="alert">{error}</p> : null}
    </section>
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
              ? "Never synced or exported."
              : "Only in a browser you trust: anyone using this browser profile can use the key."}
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
          ? "Requests stay on this computer."
          : `Forgetting does not revoke the key with ${preset.label}.`}
      </p>
    </>
  );
}

function UnlockForm({ busy, children, label, onUnlock, submitLabel = "Use key" }: {
  busy: boolean;
  children?: ReactNode;
  label: string;
  onUnlock: (key: string, remember: boolean, data: FormData) => Promise<void>;
  submitLabel?: string;
}) {
  function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const key = String(data.get("assistant-unlock-key") ?? "");
    const remember = data.get("assistant-unlock-remember") === "on";
    form.reset();
    void onUnlock(key, remember, data);
  }

  return (
    <form className="assistant-form" onSubmit={submit}>
      <label className="field">
        <span>{label} key</span>
        <input autoCapitalize="none" autoComplete="off" name="assistant-unlock-key" required spellCheck={false} type="password" />
      </label>
      {children}
      <label className="check-field">
        <input name="assistant-unlock-remember" type="checkbox" />
        <span>Remember key in this browser</span>
      </label>
      <button className="primary-button" disabled={busy} type="submit">{submitLabel}</button>
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
  const [models, setModels] = useState<ModelOption[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const preset = findPreset(provider);
  const local = preset ? isLocalPreset(preset) : false;
  const heldKey = preset ? assistantSession.keyFor({ provider, localBaseUrl: local ? localBaseUrl : null, apiKey: "" }) : null;
  const working = check.state === "working";

  useEffect(() => {
    setModels([]);
    setCustomModel(false);
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
      const options = await client.listModels(connection);
      setModels(options);
      const current = model.trim();
      const known = options.some((option) => option.id === current);
      // Newest first: an empty field takes the latest release; a typed ID the
      // list does not contain stays as a custom model.
      if (!current && options[0]) setModel(options[0].id);
      setCustomModel(Boolean(current) && !known);
      setCheck(
        options.length > 0
          ? { state: "ok", message: `${options.length} models available, newest first.` }
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
              onBlur={() => {
                if (apiKey.trim() && models.length === 0) void loadModels();
              }}
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
              Model
            </label>
            <div className="assistant-model-row">
              {models.length > 0 && !customModel ? (
                <select
                  id={`${id}-model`}
                  onChange={(event) => {
                    if (event.target.value === CUSTOM_MODEL) {
                      setCustomModel(true);
                      setModel("");
                    } else {
                      setModel(event.target.value);
                    }
                  }}
                  required
                  value={model}
                >
                  {models.map((option) => (
                    <option key={option.id} value={option.id}>{modelLabel(option)}</option>
                  ))}
                  <option value={CUSTOM_MODEL}>Type a model ID…</option>
                </select>
              ) : (
                <input
                  autoCapitalize="none"
                  autoComplete="off"
                  id={`${id}-model`}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={customModel ? "Exact model ID" : undefined}
                  required
                  spellCheck={false}
                  value={model}
                />
              )}
              {customModel && models.length > 0 ? (
                <button
                  className="secondary-button"
                  onClick={() => {
                    setCustomModel(false);
                    setModel(models[0]?.id ?? "");
                  }}
                  type="button"
                >
                  Choose from list
                </button>
              ) : (
                <button className="secondary-button" onClick={() => void loadModels()} type="button">
                  {models.length > 0 ? "Reload" : "Load models"}
                </button>
              )}
            </div>
          </div>
        ) : null}

        {preset && (preset.keyRequired || apiKey) ? (
          <>
            <label className="check-field">
              <input checked={remember} onChange={(event) => setRemember(event.target.checked)} type="checkbox" />
              <span>Remember key in this browser</span>
            </label>
            <p className="sync-help">
              Only in a browser you trust: anyone using this browser profile can use the key.
            </p>
          </>
        ) : null}

        {preset ? (
          <p className="assistant-disclosure">
            {local
              ? `Requests go to ${preset.label} on this computer.`
              : `Requests go directly from this browser to ${preset.label} (${preset.origin}), billed to your key.`}{" "}
            You see what each request sends, and nothing changes until you accept.
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
