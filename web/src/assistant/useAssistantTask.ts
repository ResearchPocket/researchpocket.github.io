import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { AssistantRequest } from "./prompts.ts";
import { assistantSession, loadAssistantClient } from "./session.ts";

export interface AssistantTask {
  /** Caller-defined identity, so one surface can tell its actions apart. */
  id: string;
  label: string;
  request: AssistantRequest;
  /** Stream text as it arrives; otherwise wait for the whole reply. */
  stream: boolean;
}

export type TaskState =
  | { kind: "idle" }
  | { kind: "consent"; task: AssistantTask }
  | { kind: "working"; task: AssistantTask; text: string }
  | { kind: "done"; task: AssistantTask; text: string }
  | { kind: "error"; task: AssistantTask; message: string };

/**
 * The one way a surface runs an assistant request: first-use confirmation,
 * cancellation, streaming, and owner-facing errors behave the same in the
 * Reader and in Zen. Results are only ever text; applying them is the
 * caller's explicit accept.
 */
export function useAssistantTask() {
  const snapshot = useSyncExternalStore(assistantSession.subscribe, assistantSession.getSnapshot);
  const [state, setState] = useState<TaskState>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function run(task: AssistantTask, consented = false) {
    const settings = assistantSession.getSnapshot().settings;
    if (!settings) return;
    if (!settings.disclosed && !consented) {
      setState({ kind: "consent", task });
      return;
    }
    if (!settings.disclosed) await assistantSession.acknowledgeDisclosure();
    const connection = assistantSession.connection();
    if (!connection) return;

    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    let partial = "";
    setState({ kind: "working", task, text: "" });
    try {
      const client = await loadAssistantClient();
      const text = task.stream
        ? await client.stream(connection, task.request, (next) => {
            partial = next;
            if (!abort.signal.aborted) setState({ kind: "working", task, text: next });
          }, abort.signal)
        : await client.complete(connection, task.request, abort.signal);
      // A newer run or a reset owns the state now; a stopped run keeps its text.
      if (controller.current !== abort) return;
      if (abort.signal.aborted) {
        setState(partial.trim() ? { kind: "done", task, text: partial.trim() } : { kind: "idle" });
        return;
      }
      setState(text.trim()
        ? { kind: "done", task, text: text.trim() }
        : { kind: "error", task, message: "The model returned nothing. Try again or choose another model." });
    } catch (cause) {
      if (controller.current !== abort) return;
      if ((cause as { category?: string }).category === "cancelled") {
        setState(partial.trim() ? { kind: "done", task, text: partial.trim() } : { kind: "idle" });
        return;
      }
      setState({ kind: "error", task, message: cause instanceof Error ? cause.message : "The assistant request failed." });
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  }

  return {
    snapshot,
    state,
    run,
    confirm: () => {
      if (state.kind === "consent") void run(state.task, true);
    },
    stop: () => controller.current?.abort(),
    reset: () => {
      const running = controller.current;
      controller.current = null;
      running?.abort();
      setState({ kind: "idle" });
    },
    destination: snapshot.preset
      ? snapshot.preset.origin
        ? `${snapshot.preset.label} (${snapshot.preset.origin})`
        : `${snapshot.preset.label} on this computer`
      : "",
  };
}

export type AssistantTaskHandle = ReturnType<typeof useAssistantTask>;
