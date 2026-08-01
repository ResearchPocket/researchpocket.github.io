import { useMemo, useState } from "react";
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
  onDelete(documentId: string): void;
  onSaveTitle(documentId: string, title: string | null): void;
  onSaveBody(documentId: string, body: string): void;
}

type SortMode = "edited" | "created" | "title";

export function ZenWorkspace(props: ZenWorkspaceProps) {
  if (props.hidden) return null;
  return props.open ? <ZenEditor {...props} open={props.open} /> : <ZenList {...props} />;
}

function ZenList({
  documents,
  busy,
  onCreate,
  onOpen,
  onDelete,
}: ZenWorkspaceProps) {
  const [draftTitle, setDraftTitle] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("edited");

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const matched = needle
      ? documents.filter((document) =>
          (document.title ?? "").toLowerCase().includes(needle),
        )
      : documents;
    const ordered = [...matched];
    if (sort === "created") ordered.sort((left, right) => right.createdAt - left.createdAt);
    if (sort === "title") {
      ordered.sort((left, right) =>
        (left.title ?? "").localeCompare(right.title ?? ""),
      );
    }
    return ordered;
  }, [documents, search, sort]);

  return (
    <section aria-labelledby="zen-heading" className="library-section zen-list" id="zen">
      <div className="zen-heading-row">
        <div className="zen-title">
          <h2 id="zen-heading">Zen</h2>
          <p className="zen-count">
            {documents.length} {documents.length === 1 ? "document" : "documents"} · titles
            and metadata only — bodies load on open
          </p>
        </div>
        <select
          aria-label="Sort documents"
          onChange={(event) => setSort(event.target.value as SortMode)}
          value={sort}
        >
          <option value="edited">edited ↓</option>
          <option value="created">created ↓</option>
          <option value="title">title A–Z</option>
        </select>
      </div>

      <form
        className="quick-capture"
        onSubmit={(event) => {
          event.preventDefault();
          onCreate(draftTitle.trim());
          setDraftTitle("");
        }}
      >
        <span aria-hidden="true">+</span>
        <input
          aria-label="New document title"
          disabled={busy}
          onChange={(event) => setDraftTitle(event.target.value)}
          placeholder="New document — title optional, ↵ creates and opens."
          type="text"
          value={draftTitle}
        />
        <span className="quick-capture-hint">or research zen add</span>
      </form>

      <div className="library-search-row">
        <label className="library-search">
          <input
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search document titles"
            type="search"
            value={search}
          />
        </label>
      </div>

      {visible.length === 0 ? (
        <p className="library-empty">
          No documents yet. Prose, lists, and todos live here — saves stay in the library.
        </p>
      ) : (
        <ol className="zen-rows">
          {visible.map((document) => (
            <li key={document.documentId}>
              <article className="zen-row">
                <span aria-hidden="true" className="zen-glyph">
                  ≡
                </span>
                <div className="zen-row-copy">
                  <h3>
                    <button
                      className="zen-open"
                      onClick={() => onOpen(document.documentId)}
                      type="button"
                    >
                      {document.title?.trim() || "Untitled document"}
                    </button>
                  </h3>
                  <p className="zen-row-meta">
                    <span>Edited {formatEdited(document.editedAt)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatBytes(document.byteLength)}</span>
                    {document.todoTotal > 0 && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="zen-todo-count">
                          {document.todoDone}/{document.todoTotal} todos
                        </span>
                      </>
                    )}
                    {document.tags.length > 0 && (
                      <span className="zen-row-tags">
                        {document.tags.map((tag) => (
                          <span key={tag}>#{tag}</span>
                        ))}
                      </span>
                    )}
                  </p>
                </div>
                <div className="zen-row-actions">
                  <button
                    aria-label={`Edit ${document.title ?? "document"}`}
                    disabled={busy}
                    onClick={() => onOpen(document.documentId)}
                    title="Edit markdown"
                    type="button"
                  >
                    ✎
                  </button>
                  <button
                    aria-label={`Delete ${document.title ?? "document"}`}
                    disabled={busy}
                    onClick={() => onDelete(document.documentId)}
                    title="Delete"
                    type="button"
                  >
                    ⌫
                  </button>
                </div>
              </article>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ZenEditor({
  open,
  busy,
  resolveMention,
  onClose,
  onSaveTitle,
  onSaveBody,
}: ZenWorkspaceProps & { open: { documentId: string; view: ZenDocumentView } }) {
  const [mode, setMode] = useState<"edit" | "view">("view");
  const [draft, setDraft] = useState(open.view.body);
  const [title, setTitle] = useState(open.view.title.value ?? "");
  const byteLength = new TextEncoder().encode(draft).length;
  const overBound = byteLength > MAX_BODY_BYTES;

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
    <section aria-labelledby="zen-doc-heading" className="zen-editor" id="zen-document">
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
        <span className="zen-budget">
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
      </div>

      <div className="zen-canvas">
        {mode === "view" ? (
          <article className="zen-reader">
            <h1 id="zen-doc-heading">
              {open.view.title.value?.trim() || "Untitled document"}
            </h1>
            {open.view.tags.length > 0 && (
              <p className="zen-tags">
                {open.view.tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </p>
            )}
            <ZenBody
              body={open.view.body}
              onToggleTodo={toggleTodo}
              resolveMention={resolveMention}
            />
          </article>
        ) : (
          <div className="zen-edit">
            <input
              aria-label="Document title"
              className="zen-title-input"
              disabled={busy}
              onBlur={() => onSaveTitle(open.documentId, title.trim() || null)}
              onChange={(event) => setTitle(event.target.value)}
              type="text"
              value={title}
            />
            <p className="zen-hint">
              CommonMark + GFM task lists · plain text only · writes past{" "}
              {formatBytes(MAX_BODY_BYTES)} fail with an explicit error
            </p>
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
                This document is over the {formatBytes(MAX_BODY_BYTES)} bound and will not
                save until it is shorter.
              </p>
            )}
          </div>
        )}
      </div>

      <footer className="zen-footer">
        <span>
          <b>esc</b> close
        </span>
        <span>autosaves locally · durable before sync reports it</span>
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
