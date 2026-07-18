import {
  type FormEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type LibraryState,
  type PendingSyncChange,
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

type LifecycleFilter = "active" | "deleted" | "all";
type SearchScope = "all" | "title" | "url" | "context" | "tags";
type SortMode = "recent" | "oldest" | "title";
type TagMatchMode = "any" | "all";
type WorkspaceView = "library" | "sync";

const LIST_BATCH_SIZE = 100;

const EMPTY_LIBRARY_STATE: LibraryState = {
  error: null,
  initialized: false,
  items: [],
  loading: true,
  pendingChanges: [],
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
  const [searchScope, setSearchScope] = useState<SearchScope>("all");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [tagSearch, setTagSearch] = useState("");
  const [tagMatchMode, setTagMatchMode] = useState<TagMatchMode>("all");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(LIST_BATCH_SIZE);
  const [view, setView] = useState<WorkspaceView>(() =>
    window.location.hash === "#restore" ? "sync" : "library",
  );
  const [capturing, setCapturing] = useState(false);
  const [editingItem, setEditingItem] = useState<LibraryItemView | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const captureOpenerRef = useRef<HTMLButtonElement | null>(null);
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
  const knownTags = useMemo(
    () =>
      Array.from(new Set(items.flatMap((item) => item.tags))).sort((left, right) =>
        left.localeCompare(right),
      ),
    [items],
  );
  const deferredQuery = useDeferredValue(query);
  const visibleItems = useMemo(
    () =>
      filterAndSortItems(
        items,
        deferredQuery,
        filter,
        searchScope,
        favoriteOnly,
        selectedTags,
        tagMatchMode,
        sortMode,
      ),
    [
      deferredQuery,
      favoriteOnly,
      filter,
      items,
      searchScope,
      selectedTags,
      sortMode,
      tagMatchMode,
    ],
  );
  const searchPending = query !== deferredQuery;
  const renderedItems = visibleItems.slice(0, visibleLimit);
  const tagFilterMatches = useMemo(() => {
    const normalizedSearch = tagSearch.trim().toLocaleLowerCase();
    if (!normalizedSearch) return [];
    return knownTags
      .filter((tag) => !selectedTags.includes(tag))
      .filter((tag) => tag.toLocaleLowerCase().includes(normalizedSearch))
      .slice(0, 8);
  }, [knownTags, selectedTags, tagSearch]);
  const appliedFilterCount =
    Number(filter !== "active") +
    Number(searchScope !== "all") +
    Number(favoriteOnly) +
    Number(selectedTags.length > 0) +
    Number(sortMode !== "recent");

  useEffect(() => {
    setVisibleLimit(LIST_BATCH_SIZE);
  }, [deferredQuery, favoriteOnly, filter, searchScope, selectedTags, sortMode, tagMatchMode]);

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

  async function initializeLibrary(targetView: WorkspaceView) {
    const initialized = await runAction(
      "Initialize library",
      "Your private local library is ready.",
      () => libraryRepository.initialize(),
    );
    if (initialized) {
      setView(targetView);
    }
  }

  async function addItem(input: AddInput) {
    const saved = await runAction("Save link", "Saved to your local library.", () =>
      libraryRepository.add(input),
    );
    if (saved) {
      setView("library");
      closeCapture();
    }
    return saved;
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
    setLocalError(null);
    editOpenerRef.current = opener;
    setEditingItem(item);
  }

  function toggleTagFilter(tag: string) {
    const selected = selectedTags.includes(tag);
    setSelectedTags((current) =>
      current.includes(tag)
        ? current.filter((value) => value !== tag)
        : [...current, tag],
    );
    setTagSearch("");
    setFiltersOpen(true);
    setAnnouncement(
      selected ? `Removed ${tag} tag filter.` : `Filtering by ${tag}.`,
    );
  }

  function openCapture(opener: HTMLButtonElement) {
    setLocalError(null);
    captureOpenerRef.current = opener;
    setCapturing(true);
  }

  function closeCapture() {
    setCapturing(false);
    setLocalError(null);
    window.requestAnimationFrame(() => {
      const opener = captureOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      captureOpenerRef.current = null;
    });
  }

  function closeEditor() {
    setEditingItem(null);
    setLocalError(null);
    window.requestAnimationFrame(() => {
      const opener = editOpenerRef.current;
      if (opener?.isConnected) opener.focus();
      editOpenerRef.current = null;
    });
  }

  const repositoryError = readStateError(libraryState.error);
  const displayedError = localError ?? repositoryError;

  if (libraryState.loading) {
    return <BootScreen />;
  }

  if (!libraryState.initialized) {
    return (
      <Welcome
        busy={busyAction !== null}
        error={displayedError}
        onInitialize={() => initializeLibrary("library")}
        onRestore={() => initializeLibrary("sync")}
        restoreFirst={window.location.hash === "#restore"}
      />
    );
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>

      <div className="workspace-chrome">
        <header className="masthead">
          <a
            aria-label="ResearchPocket product overview"
            className="brand-lockup"
            href="../"
          >
            <span aria-hidden="true" className="brand-mark">
              rp
            </span>
            <div>
              <p className="brand-name">ResearchPocket</p>
              <p className="brand-context">owner workspace</p>
            </div>
          </a>

          <div className="local-status" role="status">
            <span aria-hidden="true" className="status-dot" />
            <span className="status-label">local</span>
            <span className="status-copy">
              {formatHeaderStatus(libraryState.status, libraryState.pendingCount)}
            </span>
          </div>
        </header>

        <nav aria-label="Workspace views" className="workspace-nav">
          <button
            aria-pressed={view === "library"}
            onClick={() => setView("library")}
            type="button"
          >
            Library <span>{activeCount}</span>
          </button>
          <button
            className="workspace-action"
            onClick={(event) => openCapture(event.currentTarget)}
            type="button"
          >
            + New save
          </button>
          <button
            aria-pressed={view === "sync"}
            onClick={() => setView("sync")}
            type="button"
          >
            Sync <span>{libraryState.pendingCount}</span>
          </button>
        </nav>
      </div>

      <main id="workspace" tabIndex={-1}>
        <h1 className="sr-only">ResearchPocket owner library</h1>

        <SyncPanel
          hidden={view !== "sync"}
          pendingChanges={libraryState.pendingChanges}
          state={syncState}
        />

        <section
          aria-busy={searchPending}
          aria-labelledby="library-heading"
          className="library-section"
          hidden={view !== "library"}
          id="library"
        >
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
            <div className="search-control" role="search">
              <label className="sr-only" htmlFor="library-search">
                Search your library
              </label>
              <svg aria-hidden="true" className="search-glyph" viewBox="0 0 24 24">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m15.5 15.5 4 4" />
              </svg>
              <input
                autoComplete="off"
                id="library-search"
                name="query"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Title, URL, note, or tag"
                type="search"
                value={query}
              />
              {query ? (
                <button
                  aria-label="Clear search"
                  className="search-clear"
                  onClick={() => setQuery("")}
                  title="Clear search"
                  type="button"
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : null}
            </div>
            <button
              aria-controls="library-filters"
              aria-expanded={filtersOpen}
              className="filter-toggle"
              onClick={() => setFiltersOpen((open) => !open)}
              type="button"
            >
              Filter{appliedFilterCount > 0 ? ` · ${appliedFilterCount}` : ""}
            </button>
          </div>

          <div className="library-filters" hidden={!filtersOpen} id="library-filters">
            <label>
              <select
                aria-label="Search fields"
                id="search-scope"
                name="search-scope"
                onChange={(event) => setSearchScope(event.target.value as SearchScope)}
                value={searchScope}
              >
                <option value="all">All fields</option>
                <option value="title">Title</option>
                <option value="url">URL</option>
                <option value="context">Context</option>
                <option value="tags">Tags</option>
              </select>
            </label>
            <label>
              <select
                aria-label="Item state"
                id="lifecycle-filter"
                name="lifecycle-filter"
                onChange={(event) => setFilter(event.target.value as LifecycleFilter)}
                value={filter}
              >
                <option value="active">Active {activeCount}</option>
                <option value="deleted">Deleted {deletedCount}</option>
                <option value="all">All {items.length}</option>
              </select>
            </label>
            <label>
              <select
                aria-label="Sort order"
                id="sort-mode"
                name="sort-mode"
                onChange={(event) => setSortMode(event.target.value as SortMode)}
                value={sortMode}
              >
                <option value="recent">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="title">Title</option>
              </select>
            </label>
            <label className="filter-favorite">
              <input
                checked={favoriteOnly}
                id="favorite-filter"
                name="favorite-filter"
                onChange={(event) => setFavoriteOnly(event.target.checked)}
                type="checkbox"
              />
              <span>Favorites only</span>
            </label>
            {appliedFilterCount > 0 ? (
              <button
                className="filter-reset"
                onClick={() => {
                  setFilter("active");
                  setSearchScope("all");
                  setFavoriteOnly(false);
                  setSelectedTags([]);
                  setTagSearch("");
                  setTagMatchMode("all");
                  setSortMode("recent");
                }}
                type="button"
              >
                Reset
              </button>
            ) : null}
            {knownTags.length > 0 ? (
              <fieldset aria-label="Tag filters" className="tag-filter-group">
                <label className="tag-filter-search">
                  <input
                    aria-label="Find tags"
                    autoComplete="off"
                    id="tag-filter-search"
                    name="tag-filter-search"
                    onChange={(event) => setTagSearch(event.target.value)}
                    placeholder="Add tag filter"
                    type="search"
                    value={tagSearch}
                  />
                </label>
                <div aria-label="Tag filter selection" className="tag-filter-options">
                  {selectedTags.map((tag) => (
                    <button
                      aria-label={`${tag} ×, remove tag filter`}
                      aria-pressed="true"
                      key={tag}
                      onClick={() =>
                        setSelectedTags((current) =>
                          current.filter((value) => value !== tag),
                        )
                      }
                      type="button"
                    >
                      {tag} ×
                    </button>
                  ))}
                  {tagFilterMatches.map((tag) => (
                    <button
                      aria-label={`+ ${tag}, add tag filter`}
                      aria-pressed="false"
                      key={tag}
                      onClick={() => {
                        setSelectedTags((current) => [...current, tag]);
                        setTagSearch("");
                      }}
                      type="button"
                    >
                      + {tag}
                    </button>
                  ))}
                  {tagSearch.trim() && tagFilterMatches.length === 0 ? (
                    <span className="tag-filter-empty">No matching tags</span>
                  ) : null}
                </div>
                {selectedTags.length > 1 ? (
                  <label>
                    <select
                      aria-label="Tag matching"
                      id="tag-match-mode"
                      name="tag-match-mode"
                      onChange={(event) =>
                        setTagMatchMode(event.target.value as TagMatchMode)
                      }
                      value={tagMatchMode}
                    >
                      <option value="all">All selected tags</option>
                      <option value="any">Any selected tag</option>
                    </select>
                  </label>
                ) : null}
              </fieldset>
            ) : null}
          </div>

          <p className="result-count">
            {searchPending ? "Updating…" : pluralize(visibleItems.length, "result")}
          </p>

          {visibleItems.length === 0 ? (
            <EmptyLibrary filter={filter} hasQuery={query.trim().length > 0} />
          ) : (
            <ol className="item-list">
              {renderedItems.map((item) => (
                <LibraryItem
                  busy={busyAction !== null}
                  item={item}
                  key={item.id}
                  onDelete={deleteItem}
                  onEdit={openEditor}
                  onRestore={restoreItem}
                  onToggleTagFilter={toggleTagFilter}
                  selectedTags={selectedTags}
                />
              ))}
            </ol>
          )}
          {renderedItems.length < visibleItems.length ? (
            <button
              className="list-more"
              onClick={() => setVisibleLimit((current) => current + LIST_BATCH_SIZE)}
              type="button"
            >
              Show {Math.min(LIST_BATCH_SIZE, visibleItems.length - renderedItems.length)} more
            </button>
          ) : null}
          <div aria-atomic="true" aria-live="polite" className="sr-only">
            {searchPending
              ? "Updating library results."
              : `Showing ${renderedItems.length.toLocaleString()} of ${pluralize(visibleItems.length, "result")}`}
          </div>
        </section>
      </main>

      <footer>
        <p>local-first / private by default / no tracking</p>
        <a href="../">About and releases</a>
      </footer>

      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {displayedError && !editingItem && !capturing ? (
        <div className="error-banner" role="alert">
          <strong>Something needs your attention.</strong>
          <span>{displayedError}</span>
          {localError ? (
            <button onClick={() => setLocalError(null)} type="button">
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {editingItem ? (
          <EditDialog
            busy={busyAction !== null}
            error={localError}
            item={editingItem}
            knownTags={knownTags}
          onClose={closeEditor}
          onSave={saveEdit}
        />
      ) : null}

      {capturing ? (
        <CaptureDialog
          busy={busyAction !== null}
          error={localError}
          knownTags={knownTags}
          onAdd={addItem}
          onClose={closeCapture}
        />
      ) : null}
    </div>
  );
}

function BootScreen() {
  return (
    <main aria-busy="true" aria-live="polite" className="boot-shell">
      <span aria-hidden="true" className="welcome-monogram">rp</span>
      <p className="eyebrow">ResearchPocket / owner app</p>
      <h1>Opening this browser's library…</h1>
    </main>
  );
}

function Welcome({
  busy,
  error,
  onInitialize,
  onRestore,
  restoreFirst,
}: {
  busy: boolean;
  error: string | null;
  onInitialize: () => Promise<void>;
  onRestore: () => Promise<void>;
  restoreFirst: boolean;
}) {
  return (
    <main className="welcome-shell">
      <section aria-labelledby="welcome-heading" className="welcome-card">
        <div aria-hidden="true" className="welcome-monogram">
          rp
        </div>
        <p className="eyebrow">ResearchPocket / owner app</p>
        <h1 id="welcome-heading">
          {restoreFirst
            ? "Bring your existing library into this browser."
            : "Choose how this browser should begin."}
        </h1>
        <p className="welcome-copy">
          This device keeps its own private, offline replica. Start with an empty
          library or restore the library already synchronized by your CLI or
          another browser.
        </p>

        <div className="privacy-note">
          <strong>Local and private by default</strong>
          <span>
            Nothing leaves this device until you choose to connect private sync.
          </span>
        </div>

        {error ? <p role="alert">{error}</p> : null}

        <div className="onboarding-options">
          <section className={restoreFirst ? "onboarding-option onboarding-option-priority" : "onboarding-option"}>
            <p className="eyebrow">Existing owner</p>
            <h2>Restore from private sync</h2>
            <p>
              Prepare a pristine local replica, then enter the private repository
              and fine-grained GitHub token used by your other devices.
            </p>
            <button
              className={restoreFirst ? "primary-button" : "secondary-button"}
              disabled={busy}
              onClick={() => void onRestore()}
              type="button"
            >
              {busy ? "Preparing browser…" : "Continue to private sync"}
            </button>
          </section>

          <section className={!restoreFirst ? "onboarding-option onboarding-option-priority" : "onboarding-option"}>
            <p className="eyebrow">New library</p>
            <h2>Start locally</h2>
            <p>
              Create an empty offline library in this browser. You can connect a
              new private synchronization repository later.
            </p>
            <button
              className={!restoreFirst ? "primary-button" : "secondary-button"}
              disabled={busy}
              onClick={() => void onInitialize()}
              type="button"
            >
              {busy ? "Creating library…" : "Create a local library"}
            </button>
          </section>
        </div>

        <p className="welcome-footnote">
          Restore before making a new save. Browser storage must remain enabled
          to keep either local copy. <a href="../">Return to the product overview.</a>
        </p>
      </section>
    </main>
  );
}

function SyncPanel({
  hidden,
  pendingChanges,
  state,
}: {
  hidden: boolean;
  pendingChanges: PendingSyncChange[];
  state: BrowserSyncState;
}) {
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
    <section
      aria-labelledby="sync-heading"
      className="sync-section"
      hidden={hidden}
    >
      <div className="sync-copy">
        <p className="eyebrow">Remote</p>
        <h2 id="sync-heading">Private sync</h2>
        <p>
          Exchange immutable updates through one private GitHub repository. Git
          does not resolve library state.
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

      <div className="sync-content">
        <PendingSyncChanges
          changes={pendingChanges}
          hasSynced={Boolean(remote?.lastSuccessAt)}
          syncing={state.syncing}
        />

        {!remote ? (
          <form className="sync-form" onSubmit={(event) => void connect(event)}>
            <label className="field">
              <span>Private data repository</span>
              <input
                autoCapitalize="none"
                autoComplete="off"
                id="sync-repository"
                name="repository"
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
                id="sync-branch"
                name="branch"
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
      </div>
    </section>
  );
}

function PendingSyncChanges({
  changes,
  hasSynced,
  syncing,
}: {
  changes: PendingSyncChange[];
  hasSynced: boolean;
  syncing: boolean;
}) {
  return (
    <section
      aria-busy={syncing}
      aria-labelledby="sync-pending-heading"
      className="sync-pending"
    >
      <div className="sync-pending-heading">
        <h3 id="sync-pending-heading">Local changes waiting</h3>
        <span>{pluralize(changes.length, "change")}</span>
      </div>
      <p className="sync-pending-help">
        Outgoing changes stay on this device until GitHub confirms them. Incoming
        changes are discovered during sync.
      </p>

      {changes.length > 0 ? (
        <ol className="sync-change-list">
          {changes.map((change) => (
            <li className="sync-change" key={change.path}>
              <span className="sync-change-kind">{pendingChangeAction(change.kind)}</span>
              <div className="sync-change-copy">
                <p>{change.label}</p>
                <p>{pendingChangeDetails(change)}</p>
              </div>
              <time dateTime={change.enqueuedAt}>{formatDateTime(change.enqueuedAt)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="sync-pending-empty">
          {hasSynced
            ? "Everything from this browser is synced."
            : "No local changes are waiting to sync."}
        </p>
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
          id="github-token"
          name="github-token"
          required
          spellCheck={false}
          type="password"
        />
      </label>
      <label className="check-field sync-session-choice">
        <input
          id="remember-for-tab"
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
  error,
  knownTags,
  onAdd,
}: {
  busy: boolean;
  error: string | null;
  knownTags: string[];
  onAdd: (input: AddInput) => Promise<boolean>;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [note, setNote] = useState("");
  const [favorite, setFavorite] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onAdd({
      favorite,
      note: optionalText(note),
      tags: withTagDraft(tags, tagDraft),
      title: optionalText(title),
      url: url.trim(),
    } as AddInput);

    if (saved) {
      setUrl("");
      setTitle("");
      setTags([]);
      setTagDraft("");
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
          id="capture-url"
          inputMode="url"
          name="url"
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
          id="capture-title"
          name="title"
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What will help you recognize it?"
          type="text"
          value={title}
        />
      </label>

      <TagField
        id="capture-tags"
        knownTags={knownTags}
        onDraftChange={setTagDraft}
        onChange={setTags}
        draft={tagDraft}
        value={tags}
      />

      <label className="field field-note">
        <span>Private note <small>optional</small></span>
        <textarea
          id="capture-note"
          name="note"
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
            id="capture-favorite"
            name="favorite"
            onChange={(event) => setFavorite(event.target.checked)}
            type="checkbox"
          />
          <span>Mark as a favorite</span>
        </label>
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? "Saving…" : "Save to library"}
        </button>
      </div>
      {error ? <p className="dialog-error" role="alert">{error}</p> : null}
    </form>
  );
}

function CaptureDialog({
  busy,
  error,
  knownTags,
  onAdd,
  onClose,
}: {
  busy: boolean;
  error: string | null;
  knownTags: string[];
  onAdd: (input: AddInput) => Promise<boolean>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("#capture-url")?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      aria-labelledby="capture-dialog-heading"
      className="capture-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <div className="dialog-surface">
        <div className="dialog-heading">
          <div>
            <h2 id="capture-dialog-heading">New save</h2>
            <p>Committed locally before synchronization.</p>
          </div>
          <button
            aria-label="Close capture form"
            className="icon-button close-button"
            disabled={busy}
            onClick={onClose}
            title="Close"
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <CaptureForm
          busy={busy}
          error={error}
          knownTags={knownTags}
          onAdd={onAdd}
        />
      </div>
    </dialog>
  );
}

function TagField({
  draft,
  id,
  knownTags,
  onDraftChange,
  onChange,
  value,
}: {
  draft: string;
  id: string;
  knownTags: string[];
  onDraftChange: (value: string) => void;
  onChange: (value: string[]) => void;
  value: string[];
}) {
  const suggestions = findTagSuggestions(knownTags, value, draft);
  const suggestionsId = `${id}-suggestions`;

  function addTag(tag: string) {
    const trimmed = tag.trim();
    if (trimmed && !value.includes(trimmed)) onChange([...value, trimmed]);
    onDraftChange("");
  }

  return (
    <div className="field tag-field">
      <label className="field-caption" htmlFor={id}>
        Tags <small>Enter or comma to add</small>
      </label>
      <input
        aria-autocomplete="list"
        aria-controls={suggestions.length > 0 ? suggestionsId : undefined}
        aria-expanded={suggestions.length > 0}
        autoComplete="off"
        id={id}
        name="tag-input"
        onBlur={() => {
          if (draft.trim()) addTag(draft);
        }}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            addTag(draft);
          } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder={value.length > 0 ? "Add another tag" : "Add tags"}
        type="text"
        value={draft}
      />
      {value.length > 0 ? (
        <div aria-label="Selected tags" className="selected-tags">
          {value.map((tag) => (
            <span key={tag}>
              {tag}
              <button
                aria-label={`Remove tag ${tag}`}
                onClick={() => onChange(value.filter((value) => value !== tag))}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {suggestions.length > 0 ? (
        <div aria-label="Tag suggestions" className="tag-suggestions" id={suggestionsId}>
          {suggestions.map((tag) => (
            <button
              key={tag}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addTag(tag)}
              type="button"
            >
              + {tag}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LibraryItem({
  busy,
  item,
  onDelete,
  onEdit,
  onRestore,
  onToggleTagFilter,
  selectedTags,
}: {
  busy: boolean;
  item: LibraryItemView;
  onDelete: (item: LibraryItemView) => Promise<void>;
  onEdit: (item: LibraryItemView, opener: HTMLButtonElement) => void;
  onRestore: (item: LibraryItemView) => Promise<void>;
  onToggleTagFilter: (tag: string) => void;
  selectedTags: string[];
}) {
  const label = item.title?.trim() || item.url;
  const preview = item.note?.trim() || item.excerpt?.trim();
  const visibleTags = item.tags.slice(0, 3);
  const hiddenTags = item.tags.slice(visibleTags.length);

  return (
    <li>
      <article
        className={`item-card${
          item.deleted ? " item-card-deleted" : " item-card-editable"
        }${item.favorite ? " item-card-favorite" : ""}`}
      >
        {!item.deleted ? (
          <button
            aria-haspopup="dialog"
            aria-label={`Edit ${label}${item.favorite ? ", favorite" : ""}`}
            className="item-card-edit-trigger"
            disabled={busy}
            onClick={(event) => onEdit(item, event.currentTarget)}
            title="Edit save"
            type="button"
          />
        ) : null}
        <div className="item-row-copy">
          <h3>
            {item.deleted ? (
              <a href={item.url} rel="noreferrer" target="_blank">
                {label}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <span>
                {label}
                {item.favorite ? <span className="sr-only">, favorite</span> : null}
              </span>
            )}
          </h3>
          <p className="item-meta">
            <span>{readHostname(item.url)}</span>
            <span aria-hidden="true">·</span>
            <span>{item.deleted ? "Deleted" : "Saved"} {formatDate(item.savedAt)}</span>
            {visibleTags.length > 0 ? (
              <span
                aria-label={`Tags for ${label}`}
                className="item-inline-tags"
                role="group"
              >
                {visibleTags.map((tag) => {
                  const selected = selectedTags.includes(tag);
                  return (
                    <button
                      aria-label={`#${tag}, ${
                        selected ? "remove" : "add"
                      } tag filter`}
                      aria-pressed={selected}
                      className="item-inline-tag"
                      key={tag}
                      onClick={() => onToggleTagFilter(tag)}
                      type="button"
                    >
                      #{tag}
                    </button>
                  );
                })}
                {hiddenTags.length > 0 ? (
                  <span aria-label={`More tags: ${hiddenTags.join(", ")}`}>
                    +{hiddenTags.length}
                  </span>
                ) : null}
              </span>
            ) : null}
          </p>
          {preview ? (
            <p className="item-preview">
              <span className="sr-only">Context: </span>
              {preview}
            </p>
          ) : null}
        </div>

        <div aria-label={`Actions for ${label}`} className="item-row-actions" role="group">
          {item.deleted ? (
            <button
              aria-label={`Restore ${label}`}
              className="icon-button restore-button"
              disabled={busy}
              onClick={() => void onRestore(item)}
              title="Restore"
              type="button"
            >
              <span aria-hidden="true">↶</span>
            </button>
          ) : (
            <>
              <a
                aria-label={`Open ${label} in a new tab`}
                className="icon-button"
                href={item.url}
                rel="noreferrer"
                target="_blank"
                title="Open in new tab"
              >
                <span aria-hidden="true">↗</span>
              </a>
              <button
                aria-label={`Delete ${label}`}
                className="icon-button danger-button"
                disabled={busy}
                onClick={() => void onDelete(item)}
                title="Delete"
                type="button"
              >
                <span aria-hidden="true">×</span>
              </button>
            </>
          )}
        </div>
      </article>
    </li>
  );
}

function EditDialog({
  busy,
  error,
  item,
  knownTags,
  onClose,
  onSave,
}: {
  busy: boolean;
  error: string | null;
  item: LibraryItemView;
  knownTags: string[];
  onClose: () => void;
  onSave: (item: LibraryItemView, input: EditInput) => Promise<boolean>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(item.url);
  const [title, setTitle] = useState(item.title ?? "");
  const [excerpt, setExcerpt] = useState(item.excerpt ?? "");
  const [tags, setTags] = useState(item.tags);
  const [tagDraft, setTagDraft] = useState("");
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
      tags: withTagDraft(tags, tagDraft),
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
      <form className="edit-form" onSubmit={(event) => void submit(event)}>
        <div className="dialog-heading">
          <div>
            <h2 id="edit-heading">Edit save</h2>
            <p>{readHostname(item.url)}</p>
          </div>
          <button
            aria-label="Close edit form"
            className="icon-button close-button"
            disabled={busy}
            onClick={onClose}
            title="Close"
            type="button"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <div className="dialog-fields">
          <label className="field">
            <span>URL</span>
            <input
              autoCapitalize="none"
              id="edit-url"
              name="url"
              onChange={(event) => setUrl(event.target.value)}
              required
              type="url"
              value={url}
            />
          </label>
          <label className="field">
            <span>Title</span>
            <input
              id="edit-title"
              name="title"
              onChange={(event) => setTitle(event.target.value)}
              ref={titleRef}
              type="text"
              value={title}
            />
          </label>
          <label className="field">
            <span>Excerpt</span>
            <textarea
              id="edit-excerpt"
              name="excerpt"
              onChange={(event) => setExcerpt(event.target.value)}
              rows={3}
              value={excerpt}
            />
          </label>
          <TagField
            id="edit-tags"
            knownTags={knownTags}
            onDraftChange={setTagDraft}
            onChange={setTags}
            draft={tagDraft}
            value={tags}
          />
          <label className="field">
            <span>Private note</span>
            <textarea
              id="edit-note"
              name="note"
              onChange={(event) => setNote(event.target.value)}
              rows={5}
              value={note}
            />
          </label>
          <label className="check-field">
            <input
              checked={favorite}
              id="edit-favorite"
              name="favorite"
              onChange={(event) => setFavorite(event.target.checked)}
              type="checkbox"
            />
            <span>Favorite</span>
          </label>
          {error ? <p className="dialog-error" role="alert">{error}</p> : null}
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
      Choose New save to keep your first link. A title or note can help your
      future self remember why it mattered.
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
  searchScope: SearchScope,
  favoriteOnly: boolean,
  selectedTags: string[],
  tagMatchMode: TagMatchMode,
  sortMode: SortMode,
) {
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return items
    .filter(
      (item) =>
        filter === "all" || item.deleted === (filter === "deleted"),
    )
    .filter((item) => !favoriteOnly || item.favorite)
    .filter((item) => {
      if (selectedTags.length === 0) return true;
      return tagMatchMode === "all"
        ? selectedTags.every((tag) => item.tags.includes(tag))
        : selectedTags.some((tag) => item.tags.includes(tag));
    })
    .filter((item) => {
      if (!normalizedQuery) {
        return true;
      }

      const valuesByScope: Record<SearchScope, Array<string | null | undefined>> = {
        all: [item.url, item.title, item.excerpt, item.note, ...item.tags],
        context: [item.excerpt, item.note],
        tags: item.tags,
        title: [item.title],
        url: [item.url],
      };

      return valuesByScope[searchScope]
        .filter((value): value is string => typeof value === "string")
        .some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
    })
    .map((item) => ({
      item,
      label: (item.title?.trim() || item.url).toLocaleLowerCase(),
      savedTime: Date.parse(item.savedAt) || 0,
    }))
    .sort((left, right) => {
      if (sortMode === "title") return left.label.localeCompare(right.label);
      if (sortMode === "oldest") return left.savedTime - right.savedTime;

      return right.savedTime - left.savedTime;
    })
    .map(({ item }) => item);
}

function findTagSuggestions(knownTags: string[], selectedTags: string[], draft: string) {
  const fragment = draft.trim().toLocaleLowerCase();
  if (!fragment) return [];
  const selected = new Set(selectedTags.map((tag) => tag.toLocaleLowerCase()));
  return knownTags
    .filter((tag) => !selected.has(tag.toLocaleLowerCase()))
    .filter((tag) => fragment === "" || tag.toLocaleLowerCase().includes(fragment))
    .slice(0, 5);
}

function withTagDraft(tags: string[], draft: string) {
  const trimmedDraft = draft.trim();
  return Array.from(new Set(trimmedDraft ? [...tags, trimmedDraft] : tags));
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

function pendingChangeAction(kind: PendingSyncChange["kind"]) {
  switch (kind) {
    case "create":
      return "Added";
    case "edit":
      return "Edited";
    case "delete":
      return "Deleted";
    case "restore":
      return "Restored";
    default:
      return "Queued";
  }
}

function pendingChangeDetails(change: PendingSyncChange) {
  if (change.kind === "queued") {
    return "Stored before detailed change labels were available.";
  }
  if (change.kind === "delete") {
    return "Will move this save to deleted items.";
  }
  if (change.kind === "restore") {
    return "Will return this save to active items.";
  }

  const details: string[] = [];
  if (change.fields.length > 0) {
    const fields = change.fields.map(pendingFieldLabel).join(", ");
    details.push(change.kind === "create" ? `Includes ${fields}` : `Changed ${fields}`);
  }
  if (change.favorite !== null) {
    details.push(
      change.favorite
        ? change.kind === "create"
          ? "Favorite"
          : "Added to favorites"
        : "Removed from favorites",
    );
  }
  if (change.addedTags.length > 0) {
    const tags = change.addedTags.map((tag) => `#${tag}`).join(", ");
    details.push(change.kind === "create" ? `Tags ${tags}` : `Added ${tags}`);
  }
  if (change.removedTags.length > 0) {
    details.push(`Removed ${change.removedTags.map((tag) => `#${tag}`).join(", ")}`);
  }
  return details.join(" · ") || "Local library edit.";
}

function pendingFieldLabel(field: PendingSyncChange["fields"][number]) {
  switch (field) {
    case "url":
      return "URL";
    case "note":
      return "private note";
    default:
      return field;
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

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
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

function formatHeaderStatus(status: unknown, pendingCount: number) {
  if (pendingCount > 0) return `${pendingCount.toLocaleString()} pending`;
  if (status === "error") return "needs attention";
  if (status === "saving") return "saving";
  if (status === "loading" || status === "opening" || status === "initializing") {
    return "opening";
  }
  return "ready";
}
