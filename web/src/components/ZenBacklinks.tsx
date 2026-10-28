import { useEffect, useState } from "react";
import { libraryRepository } from "../data/library.ts";
import type { PersistedZenDocument } from "../data/db";

export function ZenBacklinks({
  target,
  documents,
  onOpen,
}: {
  target: string;
  documents: PersistedZenDocument[];
  onOpen(documentId: string): void;
}) {
  const [sources, setSources] = useState<PersistedZenDocument[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSources(null);
    setFailed(false);
    void libraryRepository
      .zenBacklinks(target, controller.signal)
      .then((ids) => {
        if (active)
          setSources(documents.filter((doc) => ids.includes(doc.documentId)));
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [target, documents]);
  return (
    <aside className="zen-backlinks" aria-label="Linked from">
      <h2>Linked from</h2>
      {failed ? (
        <p role="status">
          Links could not be read. Reopen this document to retry.
        </p>
      ) : sources === null ? (
        <p role="status">Finding links…</p>
      ) : sources.length === 0 ? (
        <p>No other Zen documents link here yet.</p>
      ) : (
        <ul>
          {sources.map((doc) => (
            <li key={doc.documentId}>
              <a
                href={`#document=${doc.documentId}`}
                onClick={(event) => {
                  event.preventDefault();
                  onOpen(doc.documentId);
                }}
              >
                {doc.title?.trim() || "Untitled document"}
              </a>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
