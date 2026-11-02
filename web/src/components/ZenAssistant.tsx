import { useEffect, useRef, useState } from "react";

import { DOCUMENT_ACTIONS, type DocumentAction } from "../assistant/prompts.ts";
import type { AssistantTaskHandle } from "../assistant/useAssistantTask.ts";
import { AppIcon } from "./AppIcon.tsx";
import { AssistantDraft, AssistantProgress } from "./AssistantParts.tsx";

export interface AssistContext {
  hasSelection: boolean;
  linkedSaves: number;
}

/**
 * The document's assistant actions behind one toolbar control. The menu reads
 * the selection and links when it opens, so each entry can say whether it
 * applies and exactly what it would send.
 */
export function ZenAssistMenu({
  disabled,
  locked,
  onOpen,
  onOpenSettings,
  onRun,
}: {
  disabled: boolean;
  locked: boolean;
  /** Called as the menu opens; returns what the actions can work on. */
  onOpen: () => AssistContext;
  onOpenSettings: () => void;
  onRun: (action: DocumentAction) => void;
}) {
  const [context, setContext] = useState<AssistContext | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!context) return;
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setContext(null);
    }
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [context]);

  function close() {
    setContext(null);
    trigger.current?.focus();
  }

  return (
    <div
      className="zen-assist"
      onKeyDown={(event) => {
        if (event.key === "Escape" && context) {
          // The editor closes the document on Escape; the open menu goes first.
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
      ref={root}
    >
      <button
        aria-expanded={context !== null}
        aria-haspopup="menu"
        aria-label="Assist"
        className="zen-tool-button"
        disabled={disabled}
        onClick={() => setContext(context ? null : onOpen())}
        // Keeps the body's focus and selection while the menu opens.
        onPointerDown={(event) => event.preventDefault()}
        ref={trigger}
        title="Assist"
        type="button"
      >
        <AppIcon name="assistant" />
        <span className="zen-tool-label">Assist</span>
      </button>
      {context ? (
        <div aria-label="Assist" className="zen-assist-menu" role="menu">
          {locked ? (
            <button
              onClick={() => {
                setContext(null);
                onOpenSettings();
              }}
              role="menuitem"
              type="button"
            >
              <span>Enter your key</span>
              <small>The assistant needs your provider key in this tab.</small>
            </button>
          ) : (
            DOCUMENT_ACTIONS.map((action) => {
              const unavailable =
                (action.needs === "selection" && !context.hasSelection) ||
                (action.needs === "links" && context.linkedSaves === 0);
              return (
                <button
                  disabled={unavailable}
                  key={action.id}
                  onClick={() => {
                    setContext(null);
                    onRun(action.id);
                  }}
                  onPointerDown={(event) => event.preventDefault()}
                  role="menuitem"
                  type="button"
                >
                  <span>{action.label}</span>
                  <small>
                    {unavailable
                      ? action.needs === "selection"
                        ? "Select text in edit mode first."
                        : "Link a save with [[ first."
                      : action.id === "linked"
                        ? `Sends ${context.linkedSaves} linked ${context.linkedSaves === 1 ? "save" : "saves"}: title, URL, excerpt.`
                        : `Sends ${action.sends}.`}
                  </small>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export type ProposalPlacement = "replace" | "cursor" | "end";

/**
 * A finished document proposal, pinned above the footer so it stays in view
 * while scrolling. Placement is the owner's choice; nothing is written until
 * one is picked.
 */
export function ZenProposal({
  error,
  onApply,
  onOpenSettings,
  placements,
  task,
}: {
  error: string | null;
  onApply: (placement: ProposalPlacement) => void;
  onOpenSettings: () => void;
  placements: ProposalPlacement[];
  task: AssistantTaskHandle;
}) {
  const { state } = task;
  if (state.kind === "idle") return null;

  return (
    <div className="assistant-block zen-proposal" aria-label="Assistant proposal" role="region">
      <div className="assistant-header">
        <h2><AppIcon name="assistant" />{state.task.label}</h2>
        <span className="assistant-model">{task.snapshot.preset?.label} · {task.snapshot.settings?.model}</span>
      </div>
      <AssistantProgress onOpenSettings={onOpenSettings} task={task} />
      {state.kind === "done" ? (
        <div className="assistant-row">
          <AssistantDraft text={state.text} />
          {error ? <p className="assistant-error" role="alert">{error}</p> : null}
          <div className="assistant-actions">
            {placements.map((placement, index) => (
              <button
                className={`assistant-action${index === 0 ? " assistant-action-primary" : ""}`}
                key={placement}
                onClick={() => onApply(placement)}
                type="button"
              >
                {placement === "replace" ? "Replace selection" : placement === "cursor" ? "Insert at cursor" : "Add to end"}
              </button>
            ))}
            <button className="assistant-action" onClick={() => void navigator.clipboard?.writeText(state.text)} type="button">
              Copy
            </button>
            <button className="assistant-action assistant-action-quiet" onClick={task.reset} type="button">
              Discard
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
