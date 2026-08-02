import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import type { PersistedZenDocument } from "../data/db";
import type { ZenDocumentView } from "../data/library.ts";

/** Bound from ADR 0011. Shown so the budget is visible before it is hit. */
const MAX_BODY_BYTES = 256 * 1024;

export interface ZenMentionTarget {
  title: string | null;
  url: string;
  deleted: boolean;
}

interface ZenWorkspaceProps {
  hidden: boolean;
  documents: PersistedZenDocument[];
  open: { documentId: string; view: ZenDocumentView } | null;
  busy: boolean;
  /** Resolves `research:item/<uuid>` mentions against the local library. */
  resolveMention(itemId: string): ZenMentionTarget | null;
  onCreate(title: string): void;
  onOpen(documentId: string): void;
  onClose(): void;
  /** Leaves Zen entirely — the index has nothing above it to go back to. */
  onLeave(): void;
  onDelete(documentId: string): void;
  onSaveTitle(documentId: string, title: string | null): void;
  onSaveBody(documentId: string, body: string): void;
}

export function ZenWorkspace(props: ZenWorkspaceProps) {
  if (props.hidden) return null;
  // Keyed by document so switching documents starts a fresh editor rather than
  // carrying the previous one's unsaved title and body across.
  return props.open ? (
    <ZenEditor {...props} key={props.open.documentId} open={props.open} />
  ) : (
    <ZenIndex {...props} />
  );
}

/**
 * The Zen index, built as a new-tab surface rather than a list page.
 *
 * Everything here is metadata the projection already holds, so the screen costs
 * nothing to open — no body is read until a document is. The single omnibar is
 * the whole interaction: typing filters, ⏎ opens, ctrl ⏎ creates. That is one
 * control instead of a create field, a search field, and a sort menu, and it is
 * the reason this works unchanged on a phone.
 */
function ZenIndex({ documents, busy, onCreate, onOpen, onLeave }: ZenWorkspaceProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const now = useClock();
  const omnibar = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLElement>(null);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const live = documents.filter((document) => !document.deleted);
    if (!needle) return live;
    return live.filter((document) =>
      (document.title ?? "").toLowerCase().includes(needle),
    );
  }, [documents, query]);

  // The trailing "New document" row is the last stop, so a query that matches
  // nothing lands on it and ⏎ creates without a second keystroke.
  const createRow = matches.length;
  const active = Math.min(selected, createRow);

  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    // Pointer-only: on a phone this would raise the keyboard over the list the
    // person came to read.
    if (window.matchMedia("(hover: hover)").matches) omnibar.current?.focus();
  }, []);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // Scoped to focus inside Zen so this never fights the command palette.
      if (!section.current?.contains(event.target as Node)) return;
      onLeave();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onLeave]);

  function create() {
    onCreate(query.trim());
    setQuery("");
  }

  function handleKey(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected(active === createRow ? 0 : active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(active === 0 ? createRow : active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (busy) return;
      const target = matches[active];
      if (event.ctrlKey || event.metaKey || !target) create();
      else onOpen(target.documentId);
    }
  }

  return (
    <section aria-labelledby="zen-heading" className="zen-index" id="zen" ref={section}>
      <div className="zen-index-column">
        <div className="zen-clock">
          <span className="zen-clock-time">{formatClock(now)}</span>
          <span className="zen-clock-date">{formatToday(now)}</span>
          <span className="zen-clock-count">
            {documents.length} {documents.length === 1 ? "document" : "documents"}
          </span>
        </div>

        <h2 className="sr-only" id="zen-heading">
          Zen
        </h2>

        <div className="zen-omnibar">
          <span aria-hidden="true">&gt;</span>
          <input
            aria-activedescendant={`zen-option-${active}`}
            aria-controls="zen-options"
            aria-expanded="true"
            aria-label="Open or create a document"
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKey}
            placeholder="Open or create a document…"
            ref={omnibar}
            role="combobox"
            type="text"
            value={query}
          />
        </div>

        <ol className="zen-options" id="zen-options" role="listbox">
          {matches.map((document, index) => (
            <li
              aria-selected={index === active}
              className="zen-option"
              id={`zen-option-${index}`}
              key={document.documentId}
              onClick={() => onOpen(document.documentId)}
              onMouseEnter={() => setSelected(index)}
              role="option"
            >
              <span aria-hidden="true" className="zen-glyph">
                ≡
              </span>
              <span className="zen-option-title">
                {document.title?.trim() || "Untitled document"}
              </span>
              <span className="zen-option-meta">
                {document.todoTotal > 0 && (
                  <>
                    {document.todoDone}/{document.todoTotal}
                    <span aria-hidden="true"> · </span>
                  </>
                )}
                {formatEdited(document.editedAt)}
              </span>
            </li>
          ))}
          <li
            aria-selected={active === createRow}
            className="zen-option zen-option-create"
            id={`zen-option-${createRow}`}
            onClick={() => !busy && create()}
            onMouseEnter={() => setSelected(createRow)}
            role="option"
          >
            <span aria-hidden="true" className="zen-glyph">
              +
            </span>
            <span className="zen-option-title">
              {query.trim() ? `New document — ${query.trim()}` : "New document"}
            </span>
            <span className="zen-option-meta">
              <b>ctrl ⏎</b>
            </span>
          </li>
        </ol>

        <p className="zen-hints">
          <span>
            <b>⏎</b> open
          </span>
          <span>
            <b>↑↓</b> select
          </span>
          <span>
            <b>esc</b> library
          </span>
        </p>
      </div>
    </section>
  );
}

function ZenEditor({
  open,
  busy,
  resolveMention,
  onClose,
  onDelete,
  onSaveTitle,
  onSaveBody,
}: ZenWorkspaceProps & { open: { documentId: string; view: ZenDocumentView } }) {
  // Reading is the default everywhere, phones included: a document is opened to
  // be read far more often than to be changed. An empty one is the exception —
  // there is nothing to read yet, so it opens ready to type.
  const [mode, setMode] = useState<"edit" | "view">(() =>
    open.view.body.trim() === "" ? "edit" : "view",
  );
  const [draft, setDraft] = useState(open.view.body);
  const [title, setTitle] = useState(open.view.title.value ?? "");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const byteLength = new TextEncoder().encode(draft).length;
  const overBound = byteLength > MAX_BODY_BYTES;
  const section = useRef<HTMLElement>(null);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (!section.current?.contains(event.target as Node)) return;
      onClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  /**
   * A checkbox toggle rewrites one line, which the domain turns into a
   * character splice — the same operation typing produces. That is why the
   * boxes stay live in view mode.
   */
  function toggleTodo(lineIndex: number) {
    const lines = open.view.body.split("\n");
    const line = lines[lineIndex];
    if (line === undefined) return;
    const toggled = line.includes("[ ]")
      ? line.replace("[ ]", "[x]")
      : line.replace(/\[[xX]\]/, "[ ]");
    if (toggled === line) return;
    lines[lineIndex] = toggled;
    const next = lines.join("\n");
    setDraft(next);
    onSaveBody(open.documentId, next);
  }

  return (
    <section
      aria-label="Zen document"
      className="zen-editor"
      id="zen-document"
      ref={section}
    >
      <div className="zen-toolbar">
        <nav aria-label="Breadcrumb" className="zen-breadcrumb">
          <button onClick={onClose} type="button">
            Zen
          </button>
          <span aria-hidden="true">/</span>
          <span className="zen-breadcrumb-current">
            {open.view.title.value?.trim() || "Untitled document"}
          </span>
        </nav>
        <span className="zen-budget zen-budget-toolbar">
          {formatBytes(byteLength)} of {formatBytes(MAX_BODY_BYTES)}
        </span>
        <div className="zen-mode" role="group" aria-label="Document mode">
          <button
            aria-pressed={mode === "edit"}
            onClick={() => setMode("edit")}
            type="button"
          >
            edit
          </button>
          <button
            aria-pressed={mode === "view"}
            onClick={() => {
              if (draft !== open.view.body) onSaveBody(open.documentId, draft);
              setMode("view");
            }}
            type="button"
          >
            view
          </button>
        </div>
        {/* Deleting belongs to the open document rather than a row in a list:
            it is the one place the thing being destroyed is fully visible. */}
        <button
          className="zen-delete"
          disabled={busy}
          onBlur={() => setConfirmingDelete(false)}
          onClick={() => {
            if (!confirmingDelete) setConfirmingDelete(true);
            else onDelete(open.documentId);
          }}
          type="button"
        >
          {confirmingDelete ? "delete?" : "⌫"}
        </button>
      </div>

      <div className="zen-canvas">
        <div className="zen-page">
          {/* The title sits outside the mode switch. It is one line, it is never
              Markdown, and hiding it behind edit mode was the only reason it
              could not be changed while reading. */}
          <input
            aria-label="Document title"
            className="zen-title-input"
            disabled={busy}
            onBlur={() => onSaveTitle(open.documentId, title.trim() || null)}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Untitled document"
            type="text"
            value={title}
          />
          {open.view.tags.length > 0 && (
            <p className="zen-tags">
              {open.view.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </p>
          )}
          {mode === "view" ? (
            <ZenBody
              body={open.view.body}
              onToggleTodo={toggleTodo}
              resolveMention={resolveMention}
            />
          ) : (
            <>
              <textarea
                aria-label="Document body"
                className="zen-body-input"
                onBlur={() => {
                  if (!overBound && draft !== open.view.body) {
                    onSaveBody(open.documentId, draft);
                  }
                }}
                onChange={(event) => setDraft(event.target.value)}
                spellCheck={false}
                value={draft}
              />
              {overBound && (
                <p className="zen-error" role="alert">
                  This document is over the {formatBytes(MAX_BODY_BYTES)} bound and will
                  not save until it is shorter.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="zen-footer">
        <span className="zen-budget zen-budget-footer">
          {formatBytes(byteLength)} of {formatBytes(MAX_BODY_BYTES)}
        </span>
        <span className="zen-footer-desktop">
          <b>esc</b> close
        </span>
        <span className="zen-footer-desktop">saves as you go</span>
        <span className="zen-footer-mobile">saved</span>
      </footer>
    </section>
  );
}

/**
 * Renders a zen body with the same Markdown stack the Reader uses.
 *
 * Only two behaviours are zen-specific, so only those are overridden: GFM task
 * checkboxes stay live (a toggle is a character splice, not an edit mode), and
 * `research:item/<uuid>` links resolve against the local library at view time.
 */
function ZenBody({
  body,
  onToggleTodo,
  resolveMention,
}: {
  body: string;
  onToggleTodo(sourceLine: number): void;
  resolveMention(itemId: string): ZenMentionTarget | null;
}) {
  return (
    <div className="zen-prose">
      <ReactMarkdown
        components={{
          // The synthetic checkbox carries no source position, so the list
          // item — which does — owns the control and the default is dropped.
          input: () => null,
          li: ({ children, node }) => {
            const line = node?.position?.start.line;
            const source =
              typeof line === "number" ? (body.split("\n")[line - 1] ?? "") : "";
            const task = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(source);
            if (!task || typeof line !== "number") return <li>{children}</li>;
            return (
              <li className="zen-todo">
                <input
                  checked={task[1]!.toLowerCase() === "x"}
                  onChange={() => onToggleTodo(line - 1)}
                  type="checkbox"
                />
                {children}
              </li>
            );
          },
          a: ({ children, href }) => {
            if (!href?.startsWith(MENTION_PREFIX)) {
              return (
                <a href={href} rel="noreferrer" target="_blank">
                  {children}
                </a>
              );
            }
            const itemId = href.slice(MENTION_PREFIX.length);
            const item = resolveMention(itemId);
            if (!item) {
              return (
                <span className="zen-mention-unresolved">{href} · unresolved</span>
              );
            }
            if (item.deleted) {
              return (
                <span>
                  <span className="zen-mention-deleted">{item.title ?? children}</span>
                  <span className="zen-mention-badge">deleted save</span>
                </span>
              );
            }
            return (
              <span>
                <a href={item.url} rel="noreferrer" target="_blank">
                  {item.title ?? children}
                </a>
                <span className="zen-mention-host"> · {hostname(item.url)}</span>
              </span>
            );
          },
        }}
        remarkPlugins={[remarkGfm]}
        skipHtml
        // The default transform drops unknown schemes, which would erase every
        // mention before it could be resolved.
        urlTransform={(url) => (url.startsWith(MENTION_PREFIX) ? url : defaultUrlTransform(url))}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

const MENTION_PREFIX = "research:item/";

/** Minute-resolution clock — the surface shows no seconds, so none are read. */
function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function formatClock(now: Date): string {
  return now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatToday(now: Date): string {
  return now.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    weekday: "long",
  });
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "saved link";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function formatEdited(iso: string): string {
  const edited = new Date(iso);
  if (Number.isNaN(edited.getTime())) return "recently";
  const elapsed = Date.now() - edited.getTime();
  if (elapsed < 60_000) return "just now";
  if (elapsed < 86_400_000) {
    return edited.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (elapsed < 172_800_000) return "yesterday";
  return edited.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
