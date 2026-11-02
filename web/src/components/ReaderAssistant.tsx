import { useEffect, useMemo, useState } from "react";

import {
  parseTagSuggestions,
  summaryRequest,
  tagSuggestionRequest,
  type ItemSource,
} from "../assistant/prompts.ts";
import { useAssistantTask } from "../assistant/useAssistantTask.ts";
import { AppIcon } from "./AppIcon.tsx";
import { AssistantDraft, AssistantProgress, describeFields } from "./AssistantParts.tsx";

export interface ReaderAssistantItem {
  id: string;
  title?: string | null;
  url: string;
  excerpt?: string | null;
  note?: string | null;
  tags: string[];
}

/**
 * Assistance for one open save. Every request starts from a button, the line
 * under the actions says what it sends, and results are proposals: dismissing
 * one changes nothing, accepting one is the same edit the owner could type.
 */
export function ReaderAssistant({
  busy,
  item,
  loadCaptured,
  onAddTags,
  onAppendToNote,
  onOpenSettings,
  vocabulary,
}: {
  busy: boolean;
  item: ReaderAssistantItem;
  loadCaptured: () => Promise<string | null>;
  onAddTags: (tags: string[]) => Promise<boolean>;
  onAppendToNote: (text: string) => Promise<boolean>;
  onOpenSettings: () => void;
  vocabulary: string[];
}) {
  const task = useAssistantTask();
  const { snapshot, state } = task;
  const [includeNote, setIncludeNote] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const hasNote = Boolean(item.note?.trim());
  const note = includeNote && hasNote;

  useEffect(() => {
    let cancelled = false;
    setCaptured(null);
    void loadCaptured().then((text) => {
      if (!cancelled) setCaptured(text);
    }, () => undefined);
    task.reset();
    setOpen(false);
    return () => {
      cancelled = true;
    };
    // A different save starts clean; the captured page belongs to the save.
  }, [item.id]);

  const source: ItemSource = {
    title: item.title ?? null,
    url: item.url,
    excerpt: item.excerpt ?? null,
    note: item.note ?? null,
    captured,
  };

  const suggestions = useMemo(
    () => state.kind === "done" && state.task.id === "tags"
      ? parseTagSuggestions(state.text, vocabulary, item.tags)
      : [],
    [state, vocabulary, item.tags],
  );

  useEffect(() => {
    setSelected(new Set(suggestions.filter(({ existing }) => existing).map(({ tag }) => tag)));
  }, [suggestions]);

  if (snapshot.status !== "ready" && snapshot.status !== "locked") return null;
  const preset = snapshot.preset!;
  const working = state.kind === "working" || state.kind === "consent";
  const preview = tagSuggestionRequest(source, note, vocabulary);

  function toggle(tag: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  async function addSelected() {
    const tags = suggestions.map(({ tag }) => tag).filter((tag) => selected.has(tag));
    if (tags.length > 0 && (await onAddTags(tags))) task.reset();
  }

  async function appendSummary() {
    if (state.kind === "done" && (await onAppendToNote(state.text))) task.reset();
  }

  // Collapsed to one quiet toggle until asked for; a running or finished
  // request keeps the panel open so its result is never hidden.
  const expanded = open || state.kind !== "idle";

  if (!expanded) {
    return (
      <button
        aria-expanded={false}
        className="assistant-toggle"
        onClick={() => setOpen(true)}
        type="button"
      >
        <AppIcon name="assistant" />
        Assistant
      </button>
    );
  }

  return (
    <section aria-labelledby="reader-assistant-heading" className="assistant-block assistant-block-reader">
      <header className="assistant-header">
        <h2 id="reader-assistant-heading">
          <button
            aria-expanded
            className="assistant-toggle"
            onClick={() => {
              task.reset();
              setOpen(false);
            }}
            title="Hide assistant"
            type="button"
          >
            <AppIcon name="assistant" />
            Assistant
          </button>
        </h2>
        <span className="assistant-model">{preset.label} · {snapshot.settings?.model}</span>
        {snapshot.status === "ready" ? (
          <div className="assistant-actions">
            <button
              className="assistant-action"
              disabled={working}
              onClick={() => void task.run({ id: "tags", label: "Suggest tags", request: tagSuggestionRequest(source, note, vocabulary), stream: false })}
              type="button"
            >
              Suggest tags
            </button>
            <button
              className="assistant-action"
              disabled={working}
              onClick={() => void task.run({ id: "summary", label: "Summarize", request: summaryRequest(source, note), stream: true })}
              type="button"
            >
              Summarize
            </button>
          </div>
        ) : null}
      </header>

      {snapshot.status === "locked" ? (
        <p className="assistant-note">
          Enter your {preset.label} key to use the assistant in this tab.{" "}
          <button className="assistant-link" onClick={onOpenSettings} type="button">Open settings</button>
        </p>
      ) : (
        <p className="assistant-note">
          Sends {describeFields(preview.fields)} to {task.destination}. Tag names go only with Suggest tags.
          {hasNote ? (
            <label className="assistant-inline-check">
              <input
                checked={includeNote}
                disabled={working}
                onChange={(event) => setIncludeNote(event.target.checked)}
                type="checkbox"
              />
              Include my note
            </label>
          ) : null}
        </p>
      )}

      <AssistantProgress onOpenSettings={onOpenSettings} task={task} />

      {state.kind === "done" && state.task.id === "tags" ? (
        suggestions.length === 0 ? (
          <div className="assistant-row">
            <p className="assistant-note">No new tags to suggest—this save looks well tagged.</p>
            <div className="assistant-actions">
              <button className="assistant-action assistant-action-quiet" onClick={task.reset} type="button">Dismiss</button>
            </div>
          </div>
        ) : (
          <fieldset className="assistant-row assistant-tags">
            <legend>Suggested tags <small>· existing tags are preselected</small></legend>
            <div className="assistant-tag-list">
              {suggestions.map(({ tag, existing }) => (
                <button
                  aria-pressed={selected.has(tag)}
                  className="assistant-tag"
                  key={tag}
                  onClick={() => toggle(tag)}
                  type="button"
                >
                  {tag}
                  {existing ? null : <small>new</small>}
                </button>
              ))}
            </div>
            <div className="assistant-actions">
              <button
                className="assistant-action assistant-action-primary"
                disabled={busy || selected.size === 0}
                onClick={() => void addSelected()}
                type="button"
              >
                {selected.size === 0 ? "Add tags" : `Add ${selected.size} ${selected.size === 1 ? "tag" : "tags"}`}
              </button>
              <button className="assistant-action assistant-action-quiet" onClick={task.reset} type="button">Dismiss</button>
            </div>
          </fieldset>
        )
      ) : null}

      {state.kind === "done" && state.task.id === "summary" ? (
        <div className="assistant-row">
          <AssistantDraft text={state.text} />
          <div className="assistant-actions">
            <button className="assistant-action assistant-action-primary" disabled={busy} onClick={() => void appendSummary()} type="button">
              Add to note
            </button>
            <button className="assistant-action" onClick={() => void navigator.clipboard?.writeText(state.text)} type="button">Copy</button>
            <button className="assistant-action assistant-action-quiet" onClick={task.reset} type="button">Discard</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
