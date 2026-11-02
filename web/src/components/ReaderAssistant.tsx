import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  parseTagSuggestions,
  summaryRequest,
  tagSuggestionRequest,
  type AssistantRequest,
  type ItemSource,
  type TagSuggestion,
} from "../assistant/prompts.ts";
import { assistantSession, loadAssistantClient } from "../assistant/session.ts";
import { MarkdownDocument } from "./MarkdownDocument.tsx";

type Task = "tags" | "summary";

type Result =
  | { kind: "idle" }
  | { kind: "consent"; task: Task }
  | { kind: "working"; task: Task; text: string }
  | { kind: "tags"; suggestions: TagSuggestion[]; selected: Set<string> }
  | { kind: "summary"; text: string }
  | { kind: "error"; task: Task; message: string };

export interface ReaderAssistantItem {
  id: string;
  title?: string | null;
  url: string;
  excerpt?: string | null;
  note?: string | null;
  tags: string[];
}

/**
 * Assistance for one open save. Every request starts from a button, the
 * preview lists exactly what it sends, and results are proposals: rejecting
 * one changes nothing, accepting one is the same edit the owner could type.
 */
export function ReaderAssistant({
  busy,
  item,
  loadCaptured,
  onAddTags,
  onAppendToNote,
  onClose,
  onOpenSettings,
  vocabulary,
}: {
  busy: boolean;
  item: ReaderAssistantItem;
  loadCaptured: () => Promise<string | null>;
  onAddTags: (tags: string[]) => Promise<boolean>;
  onAppendToNote: (text: string) => Promise<boolean>;
  onClose: () => void;
  onOpenSettings: () => void;
  vocabulary: string[];
}) {
  const snapshot = useSyncExternalStore(assistantSession.subscribe, assistantSession.getSnapshot);
  const [includeNote, setIncludeNote] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [captured, setCaptured] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const hasNote = Boolean(item.note?.trim());

  useEffect(() => {
    let cancelled = false;
    setCaptured(null);
    void loadCaptured().then((text) => {
      if (!cancelled) setCaptured(text);
    }, () => undefined);
    return () => {
      cancelled = true;
    };
    // The captured page belongs to the save, not to each render of it.
  }, [item.id]);

  useEffect(() => {
    controller.current?.abort();
    setResult({ kind: "idle" });
  }, [item.id]);

  useEffect(() => () => controller.current?.abort(), []);

  const source: ItemSource = {
    title: item.title ?? null,
    url: item.url,
    excerpt: item.excerpt ?? null,
    note: item.note ?? null,
    captured,
  };
  const note = includeNote && hasNote;

  function requestFor(task: Task): AssistantRequest {
    return task === "tags"
      ? tagSuggestionRequest(source, note, vocabulary)
      : summaryRequest(source, note);
  }

  async function start(task: Task, consented = false) {
    const settings = snapshot.settings;
    if (!settings) return;
    if (!settings.disclosed && !consented) {
      setResult({ kind: "consent", task });
      return;
    }
    if (!settings.disclosed) await assistantSession.acknowledgeDisclosure();
    const connection = assistantSession.connection();
    if (!connection) return;

    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const request = requestFor(task);
    setResult({ kind: "working", task, text: "" });
    try {
      const client = await loadAssistantClient();
      if (task === "tags") {
        const raw = await client.complete(connection, request, abort.signal);
        const suggestions = parseTagSuggestions(raw, vocabulary, item.tags);
        setResult({
          kind: "tags",
          suggestions,
          selected: new Set(suggestions.filter(({ existing }) => existing).map(({ tag }) => tag)),
        });
      } else {
        const text = await client.stream(
          connection,
          request,
          (partial) => {
            if (!abort.signal.aborted) setResult({ kind: "working", task, text: partial });
          },
          abort.signal,
        );
        setResult(text.trim() ? { kind: "summary", text: text.trim() } : {
          kind: "error",
          task,
          message: "The model returned an empty summary. Try again or choose another model.",
        });
      }
    } catch (cause) {
      const category = (cause as { category?: string }).category;
      if (category === "cancelled") {
        setResult((current) =>
          current.kind === "working" && current.task === "summary" && current.text.trim()
            ? { kind: "summary", text: current.text.trim() }
            : { kind: "idle" });
        return;
      }
      setResult({
        kind: "error",
        task,
        message: cause instanceof Error ? cause.message : "The assistant request failed.",
      });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }

  function toggle(tag: string) {
    setResult((current) => {
      if (current.kind !== "tags") return current;
      const selected = new Set(current.selected);
      if (selected.has(tag)) selected.delete(tag);
      else selected.add(tag);
      return { ...current, selected };
    });
  }

  async function addSelected() {
    if (result.kind !== "tags") return;
    const tags = result.suggestions.map(({ tag }) => tag).filter((tag) => result.selected.has(tag));
    if (tags.length > 0 && (await onAddTags(tags))) setResult({ kind: "idle" });
  }

  async function appendSummary() {
    if (result.kind !== "summary") return;
    if (await onAppendToNote(result.text)) setResult({ kind: "idle" });
  }

  if (snapshot.status === "off" || snapshot.status === "loading") return null;
  const preset = snapshot.preset!;
  const working = result.kind === "working";
  const destination = preset.origin ? `${preset.label} (${preset.origin})` : `${preset.label} on this computer`;
  const preview = requestFor(result.kind === "working" || result.kind === "consent" || result.kind === "error" ? result.task : "tags");

  return (
    <section aria-labelledby="reader-assistant-heading" className="reader-assistant">
      <header className="reader-assistant-header">
        <h2 id="reader-assistant-heading">Assistant</h2>
        <span className="reader-assistant-model">{preset.label} · {snapshot.settings?.model}</span>
        <button aria-label="Close assistant" className="close-button" onClick={onClose} type="button">×</button>
      </header>

      {snapshot.status === "locked" ? (
        <div className="reader-assistant-body">
          <p>Enter your {preset.label} key to use the assistant in this tab.</p>
          <div className="assistant-buttons">
            <button className="secondary-button" onClick={onOpenSettings} type="button">Open assistant settings</button>
          </div>
        </div>
      ) : (
        <div className="reader-assistant-body">
          <div className="assistant-buttons">
            <button className="secondary-button" disabled={working} onClick={() => void start("tags")} type="button">
              Suggest tags
            </button>
            <button className="secondary-button" disabled={working} onClick={() => void start("summary")} type="button">
              Summarize
            </button>
            {hasNote ? (
              <label className="check-field">
                <input checked={includeNote} disabled={working} onChange={(event) => setIncludeNote(event.target.checked)} type="checkbox" />
                <span>Include my note</span>
              </label>
            ) : null}
          </div>

          <details className="assistant-preview">
            <summary>What gets sent to {destination}</summary>
            <ul>
              {preview.fields.map((field) => (
                <li key={field.label}>
                  {field.label} <small>{field.characters.toLocaleString()} characters{field.truncated ? ", shortened" : ""}</small>
                </li>
              ))}
            </ul>
            {hasNote && !includeNote ? <p>Your note is not included.</p> : null}
            <p>Nothing else from your library is sent. The response is shown here and changes nothing until you accept it.</p>
          </details>

          <div aria-live="polite" className="reader-assistant-result">
            {result.kind === "consent" ? (
              <div className="assistant-consent" role="group" aria-label="Confirm sending">
                <p>
                  This sends the fields above to <strong>{destination}</strong> using your key. The
                  provider’s own data policy applies. Continue?
                </p>
                <div className="assistant-buttons">
                  <button className="primary-button" onClick={() => void start(result.task, true)} type="button">
                    Send to {preset.label}
                  </button>
                  <button className="text-button" onClick={() => setResult({ kind: "idle" })} type="button">Cancel</button>
                </div>
              </div>
            ) : null}

            {result.kind === "working" ? (
              <>
                <p className="sync-help" role="status">
                  {result.task === "tags" ? "Asking for tag suggestions…" : result.text ? "Writing summary…" : "Asking for a summary…"}
                </p>
                {result.text ? <div className="assistant-draft"><MarkdownDocument imagesAllowed={false} source={result.text} /></div> : null}
                <div className="assistant-buttons">
                  <button className="secondary-button" onClick={() => controller.current?.abort()} type="button">Stop</button>
                </div>
              </>
            ) : null}

            {result.kind === "tags" ? (
              result.suggestions.length === 0 ? (
                <p className="sync-help">No new tags suggested—this save may already be well tagged.</p>
              ) : (
                <fieldset className="assistant-tags">
                  <legend>Suggested tags <small>select the ones to add</small></legend>
                  <div className="assistant-tag-list">
                    {result.suggestions.map(({ tag, existing }) => (
                      <button
                        aria-pressed={result.selected.has(tag)}
                        className="assistant-tag"
                        key={tag}
                        onClick={() => toggle(tag)}
                        type="button"
                      >
                        <span aria-hidden="true">{result.selected.has(tag) ? "✓" : "+"}</span>
                        {tag}
                        {existing ? null : <small>new</small>}
                      </button>
                    ))}
                  </div>
                  <div className="assistant-buttons">
                    <button className="primary-button" disabled={busy || result.selected.size === 0} onClick={() => void addSelected()} type="button">
                      {result.selected.size === 0 ? "Add tags" : `Add ${result.selected.size} ${result.selected.size === 1 ? "tag" : "tags"}`}
                    </button>
                    <button className="text-button" onClick={() => setResult({ kind: "idle" })} type="button">Dismiss</button>
                  </div>
                </fieldset>
              )
            ) : null}

            {result.kind === "summary" ? (
              <div className="assistant-summary">
                <p className="assistant-label">Draft summary <small>not saved</small></p>
                <div className="assistant-draft"><MarkdownDocument imagesAllowed={false} source={result.text} /></div>
                <div className="assistant-buttons">
                  <button className="primary-button" disabled={busy} onClick={() => void appendSummary()} type="button">Add to note</button>
                  <button className="secondary-button" onClick={() => void navigator.clipboard?.writeText(result.text)} type="button">Copy</button>
                  <button className="text-button" onClick={() => setResult({ kind: "idle" })} type="button">Discard</button>
                </div>
              </div>
            ) : null}

            {result.kind === "error" ? (
              <div className="assistant-error">
                <p className="sync-error" role="alert">{result.message}</p>
                <div className="assistant-buttons">
                  <button className="secondary-button" onClick={() => void start(result.task)} type="button">Try again</button>
                  <button className="text-button" onClick={onOpenSettings} type="button">Assistant settings</button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
