import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type LibraryState,
  libraryRepository,
} from "./data/library.ts";
import {
  browserSync,
  type BrowserSyncState,
} from "./data/sync.ts";

type AddInput = Parameters<typeof libraryRepository.add>[0];
type EditInput = Parameters<typeof libraryRepository.edit>[1];

interface LibraryItemView {
  id: string;
  url: string;
  title?: string | null;
  excerpt?: string | null;
  note?: string | null;
  tags: string[];
  favorite: boolean;
  deleted: boolean;
  savedAt: string;
}

type LifecycleFilter = "active" | "deleted";

const EMPTY_LIBRARY_STATE: LibraryState = {
  error: null,
  initialized: false,
  items: [],
  loading: true,
  pendingCount: 0,
  status: "opening",
};

const EMPTY_SYNC_STATE: BrowserSyncState = {
  configuration: null,
  credentialAvailable: false,
  syncing: false,
  status: "Private sync is not connected",
  error: null,
  lastCycle: null,
};

export function App() {
  const [libraryState, setLibraryState] =
    useState<LibraryState>(EMPTY_LIBRARY_STATE);
  const [syncState, setSyncState] = useState<BrowserSyncState>(EMPTY_SYNC_STATE);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LifecycleFilter>("active");
  const [editingItem, setEditingItem] = useState<LibraryItemView | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const editOpenerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let active = true;
    const unsubscribe = libraryRepository.subscribe((nextState) => {
      if (active) {
        setLibraryState(nextState);
      }
    });
    const unsubscribeSync = browserSync.subscribe((nextState) => {
      if (active) setSyncState(nextState);
    });

    return () => {
      active = false;
      unsubscribe();
      unsubscribeSync();
    };
  }, []);

  const items = libraryState.items as unknown as LibraryItemView[];
  const activeCount = items.filter((item) => !item.deleted).length;
  const deletedCount = items.length - activeCount;
  const visibleItems = useMemo(
    () => filterAndSortItems(items, query, filter),
    [filter, items, query],
  );

  async function runAction(
    action: string,
    successMessage: string,
    operation: () => Promise<unknown>,
  ) {
    setBusyAction(action);
    setLocalError(null);
    try {
      await operation();
      setAnnouncement(successMessage);
      return true;
    } catch (error: unknown) {
      setLocalError(readError(error));
      setAnnouncement(`${action} failed.`);
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function initializeLibrary() {
    await runAction(
      "Initialize library",
      "Your private local library is ready.",
      () => libraryRepository.initialize(),
    );
  }

  async function addItem(input: AddInput) {
    return runAction("Save link", "Saved to your local library.", () =>
      libraryRepository.add(input),
    );
  }

  async function toggleFavorite(item: LibraryItemView) {
    await runAction(
      item.favorite ? "Remove favorite" : "Add favorite",
      item.favorite ? "Removed from favorites." : "Added to favorites.",
      () =>
        libraryRepository.edit(item.id, {
          favorite: !item.favorite,
        } as EditInput),
    );
  }

  async function deleteItem(item: LibraryItemView) {
    await runAction("Delete link", "Moved to deleted items.", () =>
      libraryRepository.remove(item.id),
    );
  }

  async function restoreItem(item: LibraryItemView) {
    const restored = await runAction("Restore link", "Link restored.", () =>
      libraryRepository.restore(item.id),
    );
    if (restored) {
      setFilter("active");
    }
  }

  async function saveEdit(item: LibraryItemView, input: EditInput) {
    const saved = await runAction("Update link", "Changes saved locally.", () =>
      libraryRepository.edit(item.id, {
        ...input,
        expectedNote: item.note ?? null,
      }),
    );
    if (saved) {
      closeEditor();
    }
    return saved;
  }

  function openEditor(item: LibraryItemView, opener: HTMLButtonElement) {
    editOpenerRef.current = opener;
    setEditingItem(item);
  }

  function closeEditor() {
    setEditingItem(null);
    window.requestAnimationFrame(() => {
      const opener = editOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      editOpenerRef.current = null;
    });
  }

  const repositoryError = readStateError(libraryState.error);
  const displayedError = localError ?? repositoryError;

  if (!libraryState.initialized) {
    return (
      <Welcome
        booting={libraryState.loading}
        busy={busyAction !== null}
        error={displayedError}
        onInitialize={initializeLibrary}
      />
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#library">
        Skip to library
      </a>

      <header className="masthead">
        <div className="brand-lockup">
          <span aria-hidden="true" className="brand-mark">
            RP
          </span>
          <div>
            <p className="eyebrow">Your private library</p>
            <p className="brand-name">ResearchPocket</p>
          </div>
        </div>

        <div className="local-status" role="status">
          <span aria-hidden="true" className="status-dot" />
          <span>{formatRepositoryStatus(libraryState.status)}</span>
          <span className="status-divider" aria-hidden="true">
            ·
          </span>
          <span>
            {libraryState.pendingCount === 0
              ? "All local changes saved"
              : pluralize(libraryState.pendingCount, "change") + " waiting to sync"}
          </span>
        </div>
      </header>

      <main>
        <SyncPanel state={syncState} />

        <section aria-labelledby="capture-heading" className="capture-section">
          <div className="section-intro">
            <p className="eyebrow">Capture</p>
            <h1 id="capture-heading">Keep something worth returning to.</h1>
            <p>
              Save the link with the context that matters to you. It stays on this
              device, even when you are offline.
            </p>
          </div>
          <CaptureForm busy={busyAction !== null} onAdd={addItem} />
        </section>

        <section aria-labelledby="library-heading" className="library-section" id="library">
          <div className="library-heading-row">
            <div>
              <p className="eyebrow">Library</p>
              <h2 id="library-heading">Things you chose to keep</h2>
            </div>
            <p className="library-count">
              {pluralize(activeCount, "active save")}
            </p>
          </div>

          <div className="library-tools">
            <label className="search-field">
              <span>Search your library</span>
              <input
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Title, URL, note, or tag"
                type="search"
                value={query}
              />
            </label>

            <fieldset className="filter-group">
              <legend>Show items</legend>
              <button
                aria-pressed={filter === "active"}
                className="filter-button"
                onClick={() => setFilter("active")}
                type="button"
              >
                Active <span>{activeCount}</span>
              </button>
              <button
                aria-pressed={filter === "deleted"}
                className="filter-button"
                onClick={() => setFilter("deleted")}
                type="button"
              >
                Deleted <span>{deletedCount}</span>
              </button>
            </fieldset>
          </div>

          {visibleItems.length === 0 ? (
            <EmptyLibrary filter={filter} hasQuery={query.trim().length > 0} />
          ) : (
            <ol className="item-list">
              {visibleItems.map((item) => (
                <LibraryItem
                  busy={busyAction !== null}
                  item={item}
                  key={item.id}
                  onDelete={deleteItem}
                  onEdit={openEditor}
                  onRestore={restoreItem}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </ol>
          )}
        </section>
      </main>

      <footer>
        <p>Private by default. Built for your attention, not an algorithm.</p>
      </footer>

      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {displayedError ? (
        <div className="error-banner" role="alert">
          <strong>Something needs your attention.</strong>
          <span>{displayedError}</span>
          <button onClick={() => setLocalError(null)} type="button">
            Dismiss
          </button>
        </div>
      ) : null}

      {editingItem ? (
        <EditDialog
          busy={busyAction !== null}
          item={editingItem}
          onClose={closeEditor}
          onSave={saveEdit}
        />
      ) : null}
    </div>
  );
}

function Welcome({
  booting,
  busy,
  error,
  onInitialize,
}: {
  booting: boolean;
  busy: boolean;
  error: string | null;
  onInitialize: () => Promise<void>;
}) {
  return (
    <main className="welcome-shell">
      <section aria-labelledby="welcome-heading" className="welcome-card">
        <div aria-hidden="true" className="welcome-monogram">
          RP
        </div>
        <p className="eyebrow">A quiet place for useful links</p>
        <h1 id="welcome-heading">Your research belongs to you.</h1>
        <p className="welcome-copy">
          ResearchPocket keeps a durable library in this browser. Capture, search,
          annotate, and recover your saves without an account or a network
          connection.
        </p>

        <div className="privacy-note">
          <strong>Local and private by default</strong>
          <span>
            Nothing leaves this device until you choose to connect private sync.
          </span>
        </div>

        {error ? <p role="alert">{error}</p> : null}

        <button
          className="primary-button welcome-action"
          disabled={booting || busy}
          onClick={() => void onInitialize()}
          type="button"
        >
          {booting ? "Opening your library…" : "Create local library"}
        </button>
        <p className="welcome-footnote">
          Your browser storage must remain enabled to keep this local copy.
        </p>
      </section>
    </main>
  );
}

function SyncPanel({ state }: { state: BrowserSyncState }) {
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const credential = readSyncCredential(form);
    setFormError(null);
    try {
      await browserSync.connect({ repository, branch, ...credential });
      form.reset();
    } catch (error) {
      setFormError(readError(error));
    } finally {
      clearCredentialInput(form);
    }
  }

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const credential = readSyncCredential(form);
    setFormError(null);
    try {
      await browserSync.unlock(credential);
      form.reset();
    } catch (error) {
      setFormError(readError(error));
    } finally {
      clearCredentialInput(form);
    }
  }

  async function syncNow() {
    setFormError(null);
    try {
      await browserSync.syncNow();
    } catch (error) {
      setFormError(readError(error));
    }
  }

  const error = formError ?? state.error;
  const remote = state.configuration;

  return (
    <section aria-labelledby="sync-heading" className="sync-section">
      <div className="sync-copy">
        <p className="eyebrow">Private sync</p>
        <h1 id="sync-heading">Your library, wherever you open it.</h1>
        <p>
          ResearchPocket exchanges immutable application updates through a private
          GitHub repository. Git commits never decide which save or note wins.
        </p>
        <div className="sync-state" role="status">
          <span aria-hidden="true" className="status-dot" />
          <span>{state.status}</span>
        </div>
        {remote ? (
          <p className="sync-remote">
            <strong>{remote.owner}/{remote.repository}</strong>
            <span>Branch {remote.branch}</span>
          </p>
        ) : null}
      </div>

      {!remote ? (
        <form className="sync-form" onSubmit={(event) => void connect(event)}>
          <label className="field">
            <span>Private data repository</span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              onChange={(event) => setRepository(event.target.value)}
              placeholder="owner/private-repository"
              required
              spellCheck={false}
              value={repository}
            />
          </label>
          <label className="field">
            <span>Branch <small>default branch when blank</small></span>
            <input
              autoCapitalize="none"
              autoComplete="off"
              onChange={(event) => setBranch(event.target.value)}
              placeholder="main"
              spellCheck={false}
              value={branch}
            />
          </label>
          <TokenFields />
          {error ? <p className="sync-error" role="alert">{error}</p> : null}
          <button className="primary-button" disabled={state.syncing} type="submit">
            {state.syncing ? "Connecting…" : "Connect private sync"}
          </button>
        </form>
      ) : !state.credentialAvailable ? (
        <form className="sync-form" onSubmit={(event) => void unlock(event)}>
          <p>
            Repository details stay on this device, but the credential does not.
            Enter it again to pull and push queued changes.
          </p>
          <TokenFields />
          {error ? <p className="sync-error" role="alert">{error}</p> : null}
          <button className="primary-button" disabled={state.syncing} type="submit">
            {state.syncing ? "Synchronizing…" : "Unlock and sync"}
          </button>
        </form>
      ) : (
        <div className="sync-controls">
          <p>
            Your credential is active only in this browser context and never enters
            the library, an API URL, or the service-worker cache.
          </p>
          {state.lastCycle ? (
            <dl className="sync-counts">
              <div><dt>Downloaded</dt><dd>{state.lastCycle.downloaded}</dd></div>
              <div><dt>Uploaded</dt><dd>{state.lastCycle.uploaded}</dd></div>
              <div><dt>Pending</dt><dd>{state.lastCycle.pending}</dd></div>
            </dl>
          ) : null}
          {error ? <p className="sync-error" role="alert">{error}</p> : null}
          <div className="sync-actions">
            <button
              className="primary-button"
              disabled={state.syncing}
              onClick={() => void syncNow()}
              type="button"
            >
              {state.syncing ? "Synchronizing…" : "Sync now"}
            </button>
            <button
              className="secondary-button"
              disabled={state.syncing}
              onClick={() => browserSync.forgetCredential()}
              type="button"
            >
              Forget token
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function TokenFields() {
  return (
    <>
      <label className="field sync-token-field">
        <span>Fine-grained GitHub token</span>
        <input
          autoCapitalize="none"
          autoComplete="off"
          name="github-token"
          required
          spellCheck={false}
          type="password"
        />
      </label>
      <label className="check-field sync-session-choice">
        <input
          name="remember-for-tab"
          type="checkbox"
        />
        <span>Keep the token only for this tab session</span>
      </label>
      <p className="sync-help">
        Use an expiring fine-grained token limited to this private repository with
        Contents read and write access. Leave the box off to keep it in memory only.
      </p>
    </>
  );
}

function CaptureForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (input: AddInput) => Promise<boolean>;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [favorite, setFavorite] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onAdd({
      favorite,
      note: optionalText(note),
      tags: parseTags(tags),
      title: optionalText(title),
      url: url.trim(),
    } as AddInput);

    if (saved) {
      setUrl("");
      setTitle("");
      setTags("");
      setNote("");
      setFavorite(false);
    }
  }

  return (
    <form className="capture-form" onSubmit={(event) => void submit(event)}>
      <label className="field field-url">
        <span>URL</span>
        <input
          autoCapitalize="none"
          autoComplete="url"
          inputMode="url"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/a-useful-page"
          required
          type="url"
          value={url}
        />
      </label>

      <label className="field">
        <span>Title <small>optional</small></span>
        <input
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What will help you recognize it?"
          type="text"
          value={title}
        />
      </label>

      <label className="field">
        <span>Tags <small>separate with commas</small></span>
        <input
          autoComplete="off"
          onChange={(event) => setTags(event.target.value)}
          placeholder="design, reference"
          type="text"
          value={tags}
        />
      </label>

      <label className="field field-note">
        <span>Private note <small>optional</small></span>
        <textarea
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why are you keeping this?"
          rows={3}
          value={note}
        />
      </label>

      <div className="capture-actions">
        <label className="check-field">
          <input
            checked={favorite}
            onChange={(event) => setFavorite(event.target.checked)}
            type="checkbox"
          />
          <span>Mark as a favorite</span>
        </label>
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "Saving…" : "Save to library"}
        </button>
      </div>
    </form>
  );
}

function LibraryItem({
  busy,
  item,
  onDelete,
  onEdit,
  onRestore,
  onToggleFavorite,
}: {
  busy: boolean;
  item: LibraryItemView;
  onDelete: (item: LibraryItemView) => Promise<void>;
  onEdit: (item: LibraryItemView, opener: HTMLButtonElement) => void;
  onRestore: (item: LibraryItemView) => Promise<void>;
  onToggleFavorite: (item: LibraryItemView) => Promise<void>;
}) {
  const label = item.title?.trim() || item.url;

  return (
    <li>
      <article className={`item-card${item.deleted ? " item-card-deleted" : ""}`}>
        <div className="item-card-heading">
          <div>
            <p className="item-source">{readHostname(item.url)}</p>
            <h3>
              <a href={item.url} rel="noreferrer" target="_blank">
                {label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </h3>
          </div>
          {!item.deleted ? (
            <button
              aria-label={
                item.favorite
                  ? `Remove ${label} from favorites`
                  : `Add ${label} to favorites`
              }
              aria-pressed={item.favorite}
              className="favorite-button"
              disabled={busy}
              onClick={() => void onToggleFavorite(item)}
              type="button"
            >
              <span aria-hidden="true">{item.favorite ? "★" : "☆"}</span>
              <span className="favorite-label">
                {item.favorite ? "Favorite" : "Add favorite"}
              </span>
            </button>
          ) : null}
        </div>

        {item.excerpt ? <p className="item-excerpt">{item.excerpt}</p> : null}
        {item.note ? (
          <div className="item-note">
            <p className="item-note-label">Your note</p>
            <p>{item.note}</p>
          </div>
        ) : null}

        {item.tags.length > 0 ? (
          <ul aria-label="Tags" className="tag-list">
            {item.tags.map((tag) => (
              <li key={tag}>{tag}</li>
            ))}
          </ul>
        ) : null}

        <div className="item-card-footer">
          <p>
            {item.deleted ? "Deleted" : "Saved"} {formatDate(item.savedAt)}
          </p>
          <div className="item-actions">
            {item.deleted ? (
              <button
                className="text-button restore-button"
                disabled={busy}
                onClick={() => void onRestore(item)}
                type="button"
              >
                Restore
              </button>
            ) : (
              <>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={(event) => onEdit(item, event.currentTarget)}
                  type="button"
                >
                  Edit
                </button>
                <button
                  className="text-button danger-button"
                  disabled={busy}
                  onClick={() => void onDelete(item)}
                  type="button"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      </article>
    </li>
  );
}

function EditDialog({
  busy,
  item,
  onClose,
  onSave,
}: {
  busy: boolean;
  item: LibraryItemView;
  onClose: () => void;
  onSave: (item: LibraryItemView, input: EditInput) => Promise<boolean>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(item.url);
  const [title, setTitle] = useState(item.title ?? "");
  const [excerpt, setExcerpt] = useState(item.excerpt ?? "");
  const [tags, setTags] = useState(item.tags.join(", "));
  const [note, setNote] = useState(item.note ?? "");
  const [favorite, setFavorite] = useState(item.favorite);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    dialog.showModal();
    titleRef.current?.focus();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSave(item, {
      excerpt: optionalText(excerpt),
      favorite,
      note: optionalText(note),
      tags: parseTags(tags),
      title: optionalText(title),
      url: url.trim(),
    } as EditInput);
  }

  return (
    <dialog
      aria-labelledby="edit-heading"
      className="edit-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <form onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Edit save</p>
            <h2 id="edit-heading">Keep the context useful.</h2>
          </div>
          <button
            aria-label="Close edit form"
            className="close-button"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="dialog-fields">
          <label className="field">
            <span>URL</span>
            <input
              autoCapitalize="none"
              onChange={(event) => setUrl(event.target.value)}
              required
              type="url"
              value={url}
            />
          </label>
          <label className="field">
            <span>Title</span>
            <input
              onChange={(event) => setTitle(event.target.value)}
              ref={titleRef}
              type="text"
              value={title}
            />
          </label>
          <label className="field">
            <span>Excerpt</span>
            <textarea
              onChange={(event) => setExcerpt(event.target.value)}
              rows={3}
              value={excerpt}
            />
          </label>
          <label className="field">
            <span>Tags <small>separate with commas</small></span>
            <input
              onChange={(event) => setTags(event.target.value)}
              type="text"
              value={tags}
            />
          </label>
          <label className="field">
            <span>Private note</span>
            <textarea
              onChange={(event) => setNote(event.target.value)}
              rows={5}
              value={note}
            />
          </label>
          <label className="check-field">
            <input
              checked={favorite}
              onChange={(event) => setFavorite(event.target.checked)}
              type="checkbox"
            />
            <span>Favorite</span>
          </label>
        </div>

        <div className="dialog-actions">
          <button
            className="secondary-button"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? "Saving changes…" : "Save changes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function EmptyLibrary({
  filter,
  hasQuery,
}: {
  filter: LifecycleFilter;
  hasQuery: boolean;
}) {
  let heading = "Your library is ready.";
  let body: ReactNode = (
    <>
      Save your first link above. A title or note can help your future self
      remember why it mattered.
    </>
  );

  if (hasQuery) {
    heading = "No saves match that search.";
    body = "Try fewer words, another tag, or clear the search field.";
  } else if (filter === "deleted") {
    heading = "Nothing is waiting for recovery.";
    body = "Deleted saves stay here so an accidental click is easy to undo.";
  }

  return (
    <div className="empty-state">
      <p aria-hidden="true" className="empty-mark">
        {filter === "deleted" ? "↶" : "+"}
      </p>
      <h3>{heading}</h3>
      <p>{body}</p>
    </div>
  );
}

function filterAndSortItems(
  items: LibraryItemView[],
  query: string,
  filter: LifecycleFilter,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return items
    .filter((item) => item.deleted === (filter === "deleted"))
    .filter((item) => {
      if (!normalizedQuery) {
        return true;
      }

      return [
        item.url,
        item.title,
        item.excerpt,
        item.note,
        ...item.tags,
      ]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    })
    .sort((left, right) => {
      if (left.favorite !== right.favorite) {
        return left.favorite ? -1 : 1;
      }

      return Date.parse(right.savedAt) - Date.parse(left.savedAt);
    });
}

function parseTags(value: string) {
  return Array.from(
    new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  );
}

function readSyncCredential(form: HTMLFormElement) {
  const data = new FormData(form);
  const token = data.get("github-token");
  if (typeof token !== "string") {
    throw new Error("Enter a fine-grained GitHub token.");
  }
  return {
    token,
    rememberForTab: data.get("remember-for-tab") === "on",
  };
}

function clearCredentialInput(form: HTMLFormElement) {
  const input = form.elements.namedItem("github-token");
  if (input instanceof HTMLInputElement) input.value = "";
}

function optionalText(value: string) {
  return value.length > 0 ? value : null;
}

function readHostname(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "saved link";
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(date);
}

function pluralize(count: number, noun: string) {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function readError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "The local library could not finish that action.";
}

function readStateError(error: unknown) {
  if (error === null || error === undefined || error === "") {
    return null;
  }
  return readError(error);
}

function formatRepositoryStatus(status: unknown) {
  if (typeof status !== "string") {
    return "Available offline";
  }

  const labels: Record<string, string> = {
    error: "Local library needs attention",
    initializing: "Opening local library",
    loading: "Opening local library",
    opening: "Opening local library",
    ready: "Available offline",
    saving: "Saving locally",
  };
  return labels[status] ?? status;
}
