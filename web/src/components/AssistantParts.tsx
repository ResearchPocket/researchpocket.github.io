import type { AssistantTaskHandle } from "../assistant/useAssistantTask.ts";
import type { RequestField } from "../assistant/prompts.ts";
import { MarkdownDocument } from "./MarkdownDocument.tsx";

/** "title, URL, excerpt (1.2k)" — what a request sends, on one line. */
export function describeFields(fields: RequestField[]) {
  if (fields.length === 0) return "nothing yet";
  return fields
    .map(({ label, characters, truncated }) =>
      `${label.charAt(0).toLowerCase()}${label.slice(1)} (${compactCount(characters)}${truncated ? ", shortened" : ""})`)
    .join(", ");
}

function compactCount(characters: number) {
  return characters >= 1000 ? `${(characters / 1000).toFixed(1).replace(/\.0$/u, "")}k` : String(characters);
}

/**
 * The states every assistant surface shares: the one-time destination
 * confirmation, live progress with Stop, and a recoverable error. A finished
 * result is rendered by the caller, because only it knows how to apply it.
 */
export function AssistantProgress({ task, onOpenSettings }: {
  task: AssistantTaskHandle;
  onOpenSettings: () => void;
}) {
  const { state } = task;

  if (state.kind === "consent") {
    return (
      <div className="assistant-row assistant-consent" role="group" aria-label="Confirm sending">
        <p>
          {state.task.label} sends {describeFields(state.task.request.fields)} to{" "}
          <strong>{task.destination}</strong>, using your key under the provider’s data policy.
          This is asked once per provider.
        </p>
        <div className="assistant-actions">
          <button className="assistant-action assistant-action-primary" onClick={task.confirm} type="button">
            Send
          </button>
          <button className="assistant-action assistant-action-quiet" onClick={task.reset} type="button">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "working") {
    return (
      <div className="assistant-row">
        <div className="assistant-working">
          <span role="status">{state.task.label}…</span>
          <button className="assistant-action assistant-action-quiet" onClick={task.stop} type="button">
            Stop
          </button>
        </div>
        {state.text ? <AssistantDraft text={state.text} /> : null}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="assistant-row">
        <p className="assistant-error" role="alert">{state.message}</p>
        <div className="assistant-actions">
          <button className="assistant-action" onClick={() => void task.run(state.task)} type="button">
            Try again
          </button>
          <button className="assistant-action assistant-action-quiet" onClick={onOpenSettings} type="button">
            Assistant settings
          </button>
          <button className="assistant-action assistant-action-quiet" onClick={task.reset} type="button">
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return null;
}

/** Model text is rendered inert: images stay unloaded, nothing executes. */
export function AssistantDraft({ text }: { text: string }) {
  return (
    <div className="assistant-draft">
      <MarkdownDocument imagesAllowed={false} source={text} />
    </div>
  );
}
