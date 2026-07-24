import {
  Children,
  isValidElement,
  type MouseEvent as ReactMouseEvent,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components } from "react-markdown";
import { HighlightedCodeBlock } from "./components/HighlightedCodeBlock.tsx";
import { MarkdownDocument } from "./components/MarkdownDocument.tsx";
import {
  type ReferenceDocument,
  referenceDocumentById,
  referenceDocumentBySourcePath,
  referenceDocuments,
  referenceSections,
} from "./docs/catalog.ts";

interface MarkdownHeading {
  depth: number;
  line: number;
  slug: string;
  text: string;
}

const DEFAULT_DOCUMENT_ID = "overview";
const SOURCE_ROOT = "https://github.com/ResearchPocket/researchpocket.github.io/blob/main/";

export function DocsApp() {
  const [selectedDocumentId, setSelectedDocumentId] = useState(readDocumentId);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const contentRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedDocument =
    referenceDocumentById.get(selectedDocumentId) ??
    referenceDocumentById.get(DEFAULT_DOCUMENT_ID)!;
  const headings = useMemo(
    () => parseMarkdownHeadings(selectedDocument.source),
    [selectedDocument],
  );
  const headingIds = useMemo(
    () => new Map(headings.map((heading) => [heading.line, heading.slug])),
    [headings],
  );
  const outline = headings.filter((heading) => heading.depth === 2 || heading.depth === 3);
  const normalizedQuery = deferredQuery.trim().toLocaleLowerCase();
  const matchingDocuments = useMemo(
    () =>
      normalizedQuery
        ? referenceDocuments.filter((document) =>
            [document.title, document.description, document.source]
              .join("\n")
              .toLocaleLowerCase()
              .includes(normalizedQuery),
          )
        : referenceDocuments,
    [normalizedQuery],
  );
  const selectedIndex = referenceDocuments.findIndex(
    (document) => document.id === selectedDocument.id,
  );
  const previousDocument = referenceDocuments[selectedIndex - 1];
  const nextDocument = referenceDocuments[selectedIndex + 1];

  useEffect(() => {
    function restoreLocation() {
      setSelectedDocumentId(readDocumentId());
      setNavigationOpen(false);
      window.requestAnimationFrame(() => focusDocument(window.location.hash));
    }

    window.addEventListener("popstate", restoreLocation);
    window.addEventListener("hashchange", restoreLocation);
    return () => {
      window.removeEventListener("popstate", restoreLocation);
      window.removeEventListener("hashchange", restoreLocation);
    };
  }, []);

  useEffect(() => {
    document.title = `${selectedDocument.title}: ResearchPocket docs`;
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (canonical) {
      canonical.href = new URL(canonicalDocumentHref(selectedDocument.id), window.location.origin).href;
    }
    if (description) description.content = selectedDocument.description;
    if (window.location.hash) {
      window.requestAnimationFrame(() => focusDocument(window.location.hash));
    }
  }, [selectedDocument]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.matches("input, textarea, select") || target?.isContentEditable;

      if (!isTyping && event.key === "/") {
        event.preventDefault();
        const menuVisible =
          menuButtonRef.current &&
          window.getComputedStyle(menuButtonRef.current).display !== "none";
        if (menuVisible) setNavigationOpen(true);
        window.requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (event.key === "Escape" && navigationOpen) {
        setNavigationOpen(false);
        window.requestAnimationFrame(() => menuButtonRef.current?.focus());
      }
    }

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [navigationOpen]);

  function focusDocument(hash: string) {
    const content = contentRef.current;
    if (hash) {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target && content) {
        const top =
          content.scrollTop +
          target.getBoundingClientRect().top -
          content.getBoundingClientRect().top;
        content.scrollTo({ top });
        return;
      }
    }
    content?.scrollTo({ top: 0 });
    content?.focus({ preventScroll: true });
  }

  function navigateToDocument(documentId: string, hash = "") {
    const document = referenceDocumentById.get(documentId);
    if (!document) return;
    const nextUrl = documentHref(document.id, hash);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.pushState(window.history.state, "", nextUrl);
    }
    setSelectedDocumentId(document.id);
    setNavigationOpen(false);
    window.requestAnimationFrame(() => focusDocument(hash));
  }

  function handleDocumentClick(
    event: ReactMouseEvent<HTMLAnchorElement>,
    documentId: string,
    hash = "",
  ) {
    if (
      event.button !== 0 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }
    event.preventDefault();
    navigateToDocument(documentId, hash);
  }

  const markdownComponents = createMarkdownComponents(
    selectedDocument,
    headingIds,
    handleDocumentClick,
  );

  return (
    <div className="docs-app">
      <a className="skip-link" href="#docs-content">
        Skip to guide
      </a>

      <header className="docs-header">
        <a className="docs-brand" href="../">
          <span aria-hidden="true" className="brand-mark">rp</span>
          <span>ResearchPocket</span>
          <small>Docs</small>
        </a>
        <nav aria-label="Site navigation" className="docs-header-actions">
          <a className="docs-header-link" href="../overview/">Overview</a>
          <a
            className="docs-header-link"
            href="https://github.com/ResearchPocket/researchpocket.github.io"
          >
            Source
          </a>
          <a className="docs-open-app" href="../app/">Open app</a>
          <button
            aria-controls="docs-navigation"
            aria-expanded={navigationOpen}
            className="docs-menu-button"
            onClick={() => setNavigationOpen((open) => !open)}
            ref={menuButtonRef}
            type="button"
          >
            Guide
          </button>
        </nav>
      </header>

      <div className="docs-layout">
        <aside
          className="docs-sidebar"
          data-open={navigationOpen ? "true" : "false"}
          id="docs-navigation"
        >
          <div className="docs-search">
            <label htmlFor="docs-search">Search docs</label>
            <div>
              <input
                autoComplete="off"
                id="docs-search"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search the guide"
                ref={searchRef}
                type="search"
                value={query}
              />
              <kbd>/</kbd>
            </div>
            <p>{matchingDocuments.length} of {referenceDocuments.length} pages</p>
          </div>

          <nav aria-label="Guide pages" className="docs-nav">
            {referenceSections.map((section) => {
              const sectionDocuments = matchingDocuments.filter(
                (document) => document.section === section.id,
              );
              if (sectionDocuments.length === 0) return null;
              return (
                <section aria-labelledby={`docs-section-${section.id}`} key={section.id}>
                  <h2 id={`docs-section-${section.id}`}>{section.label}</h2>
                  {sectionDocuments.map((document) => (
                    <a
                      aria-current={document.id === selectedDocument.id ? "page" : undefined}
                      href={documentHref(document.id)}
                      key={document.id}
                      onClick={(event) => handleDocumentClick(event, document.id)}
                    >
                      <span>{document.title}</span>
                    </a>
                  ))}
                </section>
              );
            })}
            {matchingDocuments.length === 0 ? (
              <p className="docs-search-empty">No reference pages match that search.</p>
            ) : null}
          </nav>

        </aside>

        <main
          className="docs-content"
          id="docs-content"
          inert={navigationOpen ? true : undefined}
          ref={contentRef}
          tabIndex={-1}
        >
          <article className="docs-article">
            <MarkdownDocument
              className="reader-markdown docs-markdown"
              components={markdownComponents}
              source={selectedDocument.source}
            />

            <nav aria-label="Adjacent reference pages" className="docs-pagination">
              {previousDocument ? (
                <a
                  href={documentHref(previousDocument.id)}
                  onClick={(event) => handleDocumentClick(event, previousDocument.id)}
                >
                  <small>Previous</small>
                  <span>← {previousDocument.title}</span>
                </a>
              ) : <span />}
              {nextDocument ? (
                <a
                  href={documentHref(nextDocument.id)}
                  onClick={(event) => handleDocumentClick(event, nextDocument.id)}
                >
                  <small>Next</small>
                  <span>{nextDocument.title} →</span>
                </a>
              ) : null}
            </nav>
          </article>
        </main>

        <aside className="docs-outline">
          <nav aria-label="On this page">
            <h2>On this page</h2>
            {outline.map((heading) => (
              <a
                className={heading.depth === 3 ? "docs-outline-nested" : undefined}
                href={documentHref(selectedDocument.id, `#${heading.slug}`)}
                key={`${heading.line}-${heading.slug}`}
                onClick={(event) =>
                  handleDocumentClick(event, selectedDocument.id, `#${heading.slug}`)
                }
              >
                {heading.text}
              </a>
            ))}
          </nav>
        </aside>
      </div>

      <div aria-atomic="true" aria-live="polite" className="sr-only">
        Showing {selectedDocument.title}
      </div>
    </div>
  );
}

function createMarkdownComponents(
  currentDocument: ReferenceDocument,
  headingIds: ReadonlyMap<number, string>,
  handleDocumentClick: (
    event: ReactMouseEvent<HTMLAnchorElement>,
    documentId: string,
    hash?: string,
  ) => void,
): Components {
  return {
    a: ({ children, href, node: _node, title, ...props }) => {
      const resolved = resolveMarkdownLink(currentDocument, href);
      if (resolved.documentId) {
        return (
          <a
            {...props}
            href={resolved.href}
            onClick={(event) =>
              handleDocumentClick(event, resolved.documentId!, resolved.hash)
            }
            title={title}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          {...props}
          href={resolved.href}
          rel={resolved.external ? "noreferrer" : undefined}
          target={resolved.external ? "_blank" : undefined}
          title={title}
        >
          {children}
        </a>
      );
    },
    h1: ({ children, node, ...props }) => (
      <h1 {...props} id={headingId(node?.position?.start.line, headingIds)}>{children}</h1>
    ),
    h2: ({ children, node, ...props }) => (
      <h2 {...props} id={headingId(node?.position?.start.line, headingIds)}>{children}</h2>
    ),
    h3: ({ children, node, ...props }) => (
      <h3 {...props} id={headingId(node?.position?.start.line, headingIds)}>{children}</h3>
    ),
    h4: ({ children, node, ...props }) => (
      <h4 {...props} id={headingId(node?.position?.start.line, headingIds)}>{children}</h4>
    ),
    h5: ({ children, node, ...props }) => (
      <h5 {...props} id={headingId(node?.position?.start.line, headingIds)}>{children}</h5>
    ),
    h6: ({ children, node, ...props }) => (
      <h6 {...props} id={headingId(node?.position?.start.line, headingIds)}>{children}</h6>
    ),
    pre: ({ children }) => {
      const child = Children.toArray(children)[0];
      if (isValidElement<{ children?: unknown; className?: string }>(child)) {
        const language = child.props.className?.match(/(?:^|\s)language-([\w-]+)/)?.[1];
        return (
          <HighlightedCodeBlock
            code={String(child.props.children ?? "").replace(/\n$/, "")}
            language={language}
          />
        );
      }
      return <pre>{children}</pre>;
    },
  };
}

function headingId(line: number | undefined, headings: ReadonlyMap<number, string>) {
  return line === undefined ? undefined : headings.get(line);
}

function parseMarkdownHeadings(source: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const slugCounts = new Map<string, number>();
  let fence: { character: string; length: number } | null = null;

  source.split("\n").forEach((line, index) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0]!, length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      return;
    }
    if (fence) return;

    const match = line.match(/^(#{1,6})[\t ]+(.+?)[\t ]*$/);
    if (!match?.[1] || !match[2]) return;
    const text = plainHeadingText(match[2].replace(/[\t ]+#+[\t ]*$/, ""));
    const baseSlug = slugifyHeading(text);
    const count = slugCounts.get(baseSlug) ?? 0;
    slugCounts.set(baseSlug, count + 1);
    headings.push({
      depth: match[1].length,
      line: index + 1,
      slug: count === 0 ? baseSlug : `${baseSlug}-${count}`,
      text,
    });
  });

  return headings;
}

function plainHeadingText(value: string) {
  return value
    .replace(/!?\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function slugifyHeading(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^\p{Letter}\p{Number}\p{Mark}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

function resolveMarkdownLink(currentDocument: ReferenceDocument, href?: string) {
  if (!href) return { external: false, href: "#" };
  if (/^(?:https?:|mailto:)/i.test(href)) {
    return { external: true, href };
  }

  const hashIndex = href.indexOf("#");
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const sourceHref = (hashIndex >= 0 ? href.slice(0, hashIndex) : href).split("?")[0]!;
  if (!sourceHref) {
    return {
      documentId: currentDocument.id,
      external: false,
      hash,
      href: documentHref(currentDocument.id, hash),
    };
  }

  const sourcePath = resolveSourcePath(currentDocument.sourcePath, sourceHref);
  const referencedDocument = referenceDocumentBySourcePath.get(sourcePath);
  if (referencedDocument) {
    return {
      documentId: referencedDocument.id,
      external: false,
      hash,
      href: documentHref(referencedDocument.id, hash),
    };
  }

  return {
    external: true,
    href: `${SOURCE_ROOT}${sourcePath}${hash}`,
  };
}

function resolveSourcePath(currentPath: string, targetPath: string) {
  const currentSegments = currentPath.split("/");
  currentSegments.pop();
  const targetSegments = targetPath.startsWith("/")
    ? targetPath.slice(1).split("/")
    : [...currentSegments, ...targetPath.split("/")];
  const resolved: string[] = [];
  for (const segment of targetSegments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved.join("/");
}

function readDocumentId() {
  const requested = new URLSearchParams(window.location.search).get("page");
  return requested && referenceDocumentById.has(requested)
    ? requested
    : DEFAULT_DOCUMENT_ID;
}

function documentHref(documentId: string, hash = "") {
  return `${window.location.pathname}?page=${encodeURIComponent(documentId)}${hash}`;
}

function canonicalDocumentHref(documentId: string) {
  return documentId === DEFAULT_DOCUMENT_ID
    ? window.location.pathname
    : documentHref(documentId);
}
