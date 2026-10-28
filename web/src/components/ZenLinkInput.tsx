import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import {
  insertZenLink,
  linkCompletion,
  type ZenLinkTarget,
} from "../data/zenLinks.ts";

export function ZenLinkInput({
  value,
  onChange,
  onBlur,
  targets,
}: {
  value: string;
  onChange(value: string): void;
  onBlur(): void;
  targets: ZenLinkTarget[];
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [range, setRange] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [explicit, setExplicit] = useState(false);
  const [selected, setSelected] = useState(0);
  const [position, setPosition] = useState<CSSProperties>({
    bottom: 12,
    maxHeight: 360,
  });
  const composing = useRef(false);
  const insertion = useRef<{ body: string; start: number; end: number } | null>(
    null,
  );
  const query = range?.query.trim().toLowerCase() ?? "";
  const matches = targets
    .filter((target) =>
      `${target.title} ${target.detail}`.toLowerCase().includes(query),
    )
    .slice(0, 8);
  const active = Math.min(selected, Math.max(0, matches.length - 1));

  useEffect(() => {
    if (!range) return;
    function reposition() {
      const viewport = window.visualViewport;
      if (
        input.current &&
        window.innerWidth >= 640 &&
        !window.matchMedia("(pointer: coarse)").matches
      ) {
        const caret = caretBounds(input.current);
        const width = Math.min(480, window.innerWidth - 24);
        const height = Math.min(360, window.innerHeight * 0.45);
        setPosition({
          left: Math.max(
            12,
            Math.min(caret.left, window.innerWidth - width - 12),
          ),
          right: "auto",
          bottom: "auto",
          top:
            window.innerHeight - caret.bottom >= height + 20
              ? caret.bottom + 8
              : Math.max(12, caret.top - height - 8),
          width,
          maxHeight: height,
        });
        return;
      }
      setPosition({
        bottom: viewport
          ? Math.max(
              12,
              window.innerHeight - viewport.height - viewport.offsetTop + 12,
            )
          : 12,
        maxHeight: Math.min(
          360,
          (viewport?.height ?? window.innerHeight) * 0.6,
        ),
      });
    }
    reposition();
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  }, [range?.start, range?.end, range?.query, value]);

  useEffect(() => {
    if (!range) return;
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, query, listId, range !== null]);

  useEffect(() => {
    if (!range) return;
    function outside(event: PointerEvent) {
      const target = event.target as Element;
      if (
        target.closest(".zen-link-picker, .zen-link-tools") ||
        target === input.current
      )
        return;
      setRange(null);
      setExplicit(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [range !== null]);

  function updateRange(element: HTMLTextAreaElement) {
    if (explicit) {
      close();
      return;
    }
    if (composing.current) return;
    setRange(
      linkCompletion(
        element.value,
        element.selectionStart,
        element.selectionEnd,
      ),
    );
    setSelected(0);
  }
  function close() {
    setRange(null);
    setExplicit(false);
  }
  function choose(target: ZenLinkTarget) {
    if (!range) return;
    const saved = insertion.current;
    if (
      explicit &&
      (!saved ||
        saved.body !== value ||
        saved.start !== input.current?.selectionStart ||
        saved.end !== input.current?.selectionEnd)
    ) {
      close();
      return;
    }
    const next = insertZenLink(value, range.start, range.end, target);
    onChange(next.body);
    close();
    requestAnimationFrame(() => {
      input.current?.focus({ preventScroll: true });
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  }
  function key(event: React.KeyboardEvent) {
    if (!range || event.nativeEvent.isComposing || composing.current) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      input.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(
        matches.length
          ? (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
              matches.length
          : 0,
      );
    } else if (event.key === "Enter" && matches[active]) {
      event.preventDefault();
      choose(matches[active]);
    }
  }

  return (
    <>
      <div className="zen-link-tools">
        <button
          type="button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const element = input.current!;
            insertion.current = {
              body: value,
              start: element.selectionStart,
              end: element.selectionEnd,
            };
            setRange({
              start: element.selectionStart,
              end: element.selectionEnd,
              query: "",
            });
            setExplicit(true);
            setSelected(0);
            requestAnimationFrame(() => search.current?.focus());
          }}
        >
          Insert link
        </button>
        <span>or type [[ to link a document or save</span>
      </div>
      <textarea
        aria-label="Document body"
        aria-autocomplete="list"
        aria-controls={range ? listId : undefined}
        aria-activedescendant={
          range && matches.length ? `${listId}-${active}` : undefined
        }
        className="zen-body-input"
        ref={input}
        onBlur={(event) => {
          onBlur();
          if (!event.relatedTarget?.closest(".zen-link-picker")) close();
        }}
        onChange={(event) => {
          onChange(event.target.value);
          updateRange(event.target);
        }}
        onClick={(event) => updateRange(event.currentTarget)}
        onSelect={() => {
          if (explicit && document.activeElement === input.current) close();
        }}
        onCompositionStart={() => {
          composing.current = true;
          close();
        }}
        onCompositionEnd={(event) => {
          composing.current = false;
          updateRange(event.currentTarget);
        }}
        onKeyDown={key}
        onKeyUp={(event) => {
          if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            updateRange(event.currentTarget);
        }}
        spellCheck={false}
        value={value}
      />
      {range && (
        <div className="zen-link-picker" style={position}>
          <div className="zen-link-picker-heading">
            <strong>Link to</strong>
            <button
              type="button"
              aria-label="Close link suggestions"
              onClick={() => {
                close();
                input.current?.focus();
              }}
            >
              ×
            </button>
          </div>
          {explicit && (
            <input
              aria-label="Find a document or save"
              autoComplete="off"
              ref={search}
              onChange={(event) => {
                setRange({ ...range, query: event.target.value });
                setSelected(0);
              }}
              onKeyDown={key}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={
                matches.length ? `${listId}-${active}` : undefined
              }
              value={range.query}
            />
          )}
          <ul id={listId} role="listbox" aria-label="Link suggestions">
            {matches.map((target, index) => (
              <li
                key={`${target.kind}:${target.id}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(target)}
              >
                <span>{target.title}</span>
                <small>
                  {target.kind === "zen" ? "document" : "save"} ·{" "}
                  {target.detail}
                </small>
              </li>
            ))}
          </ul>
          {matches.length === 0 && (
            <p role="status">No matching documents or saves.</p>
          )}
        </div>
      )}
    </>
  );
}

/** Measure the caret with the textarea's own wrapping, without interpreting text as HTML. */
function caretBounds(input: HTMLTextAreaElement): DOMRect {
  const bounds = input.getBoundingClientRect();
  const computed = window.getComputedStyle(input);
  const mirror = document.createElement("div");
  for (const property of [
    "font",
    "line-height",
    "letter-spacing",
    "padding",
    "border",
    "box-sizing",
    "word-break",
    "tab-size",
    "direction",
  ])
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    width: `${bounds.width}px`,
    left: `${bounds.left - input.scrollLeft}px`,
    top: `${bounds.top - input.scrollTop}px`,
  });
  mirror.setAttribute("aria-hidden", "true");
  mirror.textContent = input.value.slice(0, input.selectionStart);
  const caret = document.createElement("span");
  caret.textContent = "\u200b";
  mirror.append(caret);
  document.body.append(mirror);
  const result = caret.getBoundingClientRect();
  mirror.remove();
  return result;
}
