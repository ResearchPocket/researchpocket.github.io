import {
  type SubmitEvent,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MarkdownDocument } from "./components/MarkdownDocument.tsx";
import {
  type LibraryState,
  type PendingSyncChange,
  type UndoableChange,
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
type WorkspaceView = "library" | "settings" | "sync";
type Density = "comfortable" | "compact";

interface ThemeColors {
  text: string;
  background: string;
  primary: string;
  secondary: string;
  accent: string;
}

interface ThemePreset {
  id: string;
  label: string;
  colors: ThemeColors;
}

interface UndoNotice {
  change: UndoableChange;
  message: string;
}

const DENSITY_STORAGE_KEY = "researchpocket.ui.density";
const THEME_STORAGE_KEY = "researchpocket.ui.theme";

const DEFAULT_THEME: ThemeColors = {
  text: "#f5f1e9",
  background: "#1a150c",
  primary: "#d5c8a4",
  secondary: "#33656f",
  accent: "#5156ae",
};

const THEME_PRESETS: ThemePreset[] = [
  { id: "researchpocket", label: "ResearchPocket", colors: DEFAULT_THEME },
  {
    id: "dracula",
    label: "Dracula",
    colors: {
      text: "#f8f8f2",
      background: "#282a36",
      primary: "#bd93f9",
      secondary: "#8be9fd",
      accent: "#ff79c6",
    },
  },
  {
    id: "nord",
    label: "Nord",
    colors: {
      text: "#eceff4",
      background: "#2e3440",
      primary: "#88c0d0",
      secondary: "#81a1c1",
      accent: "#b48ead",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    colors: {
      text: "#eee8d5",
      background: "#002b36",
      primary: "#b58900",
      secondary: "#2aa198",
      accent: "#268bd2",
    },
  },
  {
    id: "gruvbox-dark",
    label: "Gruvbox Dark",
    colors: {
      text: "#ebdbb2",
      background: "#282828",
      primary: "#fabd2f",
      secondary: "#8ec07c",
      accent: "#d3869b",
    },
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    colors: {
      text: "#cdd6f4",
      background: "#1e1e2e",
      primary: "#cba6f7",
      secondary: "#89b4fa",
      accent: "#f5c2e7",
    },
  },
];

const THEME_FIELDS: { key: keyof ThemeColors; label: string }[] = [
  { key: "text", label: "Text" },
  { key: "background", label: "Background" },
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "accent", label: "Accent" },
];

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
  const [density, setDensity] = useState<Density>(() => readDensityPreference());
  const [theme, setTheme] = useState<ThemeColors>(() => readThemePreference());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(LIST_BATCH_SIZE);
  const [view, setView] = useState<WorkspaceView>(() => readWorkspaceView());
  const [capturing, setCapturing] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [readerItem, setReaderItem] = useState<LibraryItemView | null>(null);
  const [editingItem, setEditingItem] = useState<LibraryItemView | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [autoBootstrapAttempted, setAutoBootstrapAttempted] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
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

  useEffect(() => {
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
    } catch {
      // The preference remains active for this tab when storage is unavailable.
    }
  }, [density]);

  useEffect(() => {
    applyThemePreference(theme);
    try {
      if (themesEqual(theme, DEFAULT_THEME)) {
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(
          THEME_STORAGE_KEY,
          JSON.stringify({ colors: theme, version: 1 }),
        );
      }
    } catch {
      // The preference remains active for this tab when storage is unavailable.
    }
  }, [theme]);

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.matches("input, textarea, select") || target?.isContentEditable;

      if (
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }

      if (event.key === "Escape") {
        setCommandOpen(false);
        closeReader();
        return;
      }

      if (
        !isTyping &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z" &&
        undoNotice &&
        busyAction === null
      ) {
        event.preventDefault();
        void undoLastChange();
        return;
      }

      if (!isTyping && event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>("#library-search")?.focus();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [busyAction, undoNotice]);

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
  const tagCounts = useMemo(
    () =>
      knownTags.map((tag) => ({
        count: items.filter((item) => !item.deleted && item.tags.includes(tag)).length,
        tag,
      })),
    [items, knownTags],
  );

  useEffect(() => {
    function restoreNavigationFromHistory() {
      const match = window.location.hash.match(/^#item=(.+)$/);
      if (!match) {
        setReaderItem(null);
        setView(readWorkspaceView());
        return;
      }
      const itemId = decodeURIComponent(match[1]!);
      setReaderItem(items.find((item) => item.id === itemId) ?? null);
    }

    window.addEventListener("popstate", restoreNavigationFromHistory);
    restoreNavigationFromHistory();
    return () =>
      window.removeEventListener("popstate", restoreNavigationFromHistory);
  }, [items]);
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
    return knownTags
      .filter((tag) => !selectedTags.includes(tag))
      .filter(
        (tag) =>
          !normalizedSearch || tag.toLocaleLowerCase().includes(normalizedSearch),
      )
      .slice(0, 50);
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

  function navigateToView(nextView: WorkspaceView) {
    const hash = nextView === "library" ? "" : `#${nextView}`;
    const nextUrl = `${window.location.pathname}${window.location.search}${hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.pushState(window.history.state, "", nextUrl);
    }
    setView(nextView);
  }

  useEffect(() => {
    if (
      libraryState.loading ||
      libraryState.initialized ||
      autoBootstrapAttempted ||
      busyAction !== null
    ) {
      return;
    }

    const target = window.location.hash;
    if (target !== "#new" && target !== "#restore") return;
    setAutoBootstrapAttempted(true);
    void initializeLibrary(target === "#restore" ? "sync" : "library");
  }, [autoBootstrapAttempted, busyAction, libraryState.initialized, libraryState.loading]);

  async function addItem(input: AddInput) {
    let undo: UndoableChange | null = null;
    const saved = await runAction("Save link", "Saved to your local library.", () =>
      libraryRepository.add(input).then((change) => {
        undo = change;
      }),
    );
    if (saved) {
      offerUndo(undo, "Saved link.");
      navigateToView("library");
      closeCapture();
    }
    return saved;
  }

  async function deleteItem(item: LibraryItemView) {
    let undo: UndoableChange | null = null;
    const deleted = await runAction("Delete link", "Moved to deleted items.", () =>
      libraryRepository.remove(item.id).then((change) => {
        undo = change;
      }),
    );
    if (deleted) offerUndo(undo, "Moved link to deleted items.");
  }

  async function restoreItem(item: LibraryItemView) {
    let undo: UndoableChange | null = null;
    const restored = await runAction("Restore link", "Link restored.", () =>
      libraryRepository.restore(item.id).then((change) => {
        undo = change;
      }),
    );
    if (restored) {
      offerUndo(undo, "Restored link.");
      setFilter("active");
    }
  }

  async function toggleFavorite(item: LibraryItemView) {
    let undo: UndoableChange | null = null;
    const saved = await runAction(
      item.favorite ? "Remove favorite" : "Add favorite",
      item.favorite ? "Removed from favorites." : "Added to favorites.",
      () =>
        libraryRepository.edit(item.id, {
          favorite: !item.favorite,
          expectedNote: item.note ?? null,
        }).then((change) => {
          undo = change;
        }),
    );
    if (saved) {
      offerUndo(
        undo,
        item.favorite ? "Removed from favorites." : "Added to favorites.",
      );
    }
  }

  async function saveEdit(item: LibraryItemView, input: EditInput) {
    let undo: UndoableChange | null = null;
    const saved = await runAction("Update link", "Changes saved locally.", () =>
      libraryRepository.edit(item.id, {
        ...input,
        expectedNote: item.note ?? null,
      }).then((change) => {
        undo = change;
      }),
    );
    if (saved) {
      offerUndo(undo, "Changes saved.");
      closeEditor();
    }
    return saved;
  }

  function offerUndo(change: UndoableChange | null, message: string) {
    if (!change) return;
    setUndoNotice({ change, message });
    setAnnouncement(`${message} Undo is available.`);
  }

  async function undoLastChange() {
    const notice = undoNotice;
    if (!notice || busyAction !== null) return;
    const undone = await runAction("Undo change", "Last change undone.", () =>
      libraryRepository.undo(notice.change),
    );
    if (undone) {
      setUndoNotice(null);
      setAnnouncement("Last change undone.");
    }
  }

  function openEditor(item: LibraryItemView, opener: HTMLButtonElement) {
    setLocalError(null);
    editOpenerRef.current = opener;
    setEditingItem(item);
  }

  function openReader(item: LibraryItemView, replace = false) {
    const nextUrl = `${window.location.pathname}${window.location.search}#item=${encodeURIComponent(item.id)}`;
    const nextState = { ...window.history.state, researchPocketReader: true };
    if (replace) window.history.replaceState(nextState, "", nextUrl);
    else window.history.pushState(nextState, "", nextUrl);
    setReaderItem(item);
  }

  function closeReader() {
    if (!window.location.hash.startsWith("#item=")) {
      setReaderItem(null);
      return;
    }
    if (window.history.state?.researchPocketReader) {
      window.history.back();
      return;
    }
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    setReaderItem(null);
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
    navigateToView("library");
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
          <button
            aria-label={view === "library" ? "ResearchPocket library" : "Back to library"}
            className="brand-lockup"
            onClick={() => navigateToView("library")}
            type="button"
          >
            <span aria-hidden="true" className="brand-mark">
              rp
            </span>
            <p className="brand-name">ResearchPocket</p>
            <p className="brand-context">
              {view === "library" ? "owner workspace" : "← library"}
            </p>
          </button>

          <div className="masthead-actions">
            <div className="local-status" role="status">
              <span aria-hidden="true" className="status-dot" />
              <span className="status-label">local</span>
              <span className="status-copy">
                {formatHeaderStatus(libraryState.status, libraryState.pendingCount)}
              </span>
            </div>
            <button
              className="command-trigger"
              onClick={() => setCommandOpen(true)}
              type="button"
            >
              search or command <kbd>Ctrl Shift P</kbd>
            </button>
          </div>
        </header>
      </div>

      <div className="workspace-layout">
        <aside className="tag-rail">
          <nav aria-label="Library views" className="rail-nav">
            <button
              aria-current={view === "library" && filter === "active" && !favoriteOnly ? "page" : undefined}
              onClick={() => {
                navigateToView("library");
                setFilter("active");
                setFavoriteOnly(false);
                setSelectedTags([]);
              }}
              type="button"
            >
              <span>All saves</span><small>{activeCount}</small>
            </button>
            <button
              aria-current={view === "library" && favoriteOnly ? "page" : undefined}
              onClick={() => {
                navigateToView("library");
                setFilter("active");
                setFavoriteOnly(true);
                setSelectedTags([]);
              }}
              type="button"
            >
              <span>★ Favorites</span>
              <small>{items.filter((item) => !item.deleted && item.favorite).length}</small>
            </button>
            <button
              aria-current={view === "library" && filter === "deleted" ? "page" : undefined}
              onClick={() => {
                navigateToView("library");
                setFilter("deleted");
                setFavoriteOnly(false);
                setSelectedTags([]);
              }}
              type="button"
            >
              <span>Archive</span><small>{deletedCount}</small>
            </button>
          </nav>

          <div className="rail-tags">
            <div className="rail-heading">
              <p>Tags</p>
              <button onClick={() => setFiltersOpen(true)} type="button">manage</button>
            </div>
            <div className="rail-tag-list">
              {tagCounts.map(({ count, tag }) => (
                <button
                  aria-current={selectedTags.includes(tag) ? "page" : undefined}
                  key={tag}
                  onClick={() => toggleTagFilter(tag)}
                  type="button"
                >
                  <span>#{tag}</span><small>{count}</small>
                </button>
              ))}
            </div>
          </div>

          <button
            aria-controls="library-filters"
            aria-expanded={filtersOpen}
            className="mobile-tag-filter-trigger"
            onClick={() => setFiltersOpen(true)}
            type="button"
          >
            Tags{selectedTags.length > 0 ? ` · ${selectedTags.length}` : ""}
          </button>

          <nav aria-label="Workspace utilities" className="rail-utilities">
            <button onClick={() => navigateToView("sync")} type="button">
              <span>Sync</span><small>{libraryState.pendingCount} pending</small>
            </button>
            <button
              aria-current={view === "settings" ? "page" : undefined}
              onClick={() => navigateToView("settings")}
              type="button"
            >
              <span>Settings</span>
            </button>
          </nav>
        </aside>

        <main id="workspace" tabIndex={-1}>
          <h1 className="sr-only">ResearchPocket owner library</h1>

        <SyncPanel
          activeItemIds={new Set(items.filter((item) => !item.deleted).map((item) => item.id))}
          busy={busyAction !== null}
          hidden={view !== "sync"}
          onDeletePendingItem={(itemId) => {
            const item = items.find((candidate) => candidate.id === itemId);
            if (item && !item.deleted) void deleteItem(item);
          }}
          pendingChanges={libraryState.pendingChanges}
          state={syncState}
        />

        <SettingsPanel
          density={density}
          hidden={view !== "settings"}
          onDensityChange={setDensity}
          onThemeChange={setTheme}
          theme={theme}
        />

          <section
          aria-busy={searchPending}
          aria-labelledby="library-heading"
          className="library-section"
          hidden={view !== "library"}
          id="library"
        >
          <div className="library-heading-row">
            <div className="library-title">
              <h2 id="library-heading">
                {favoriteOnly ? "Favorites" : filter === "deleted" ? "Archive" : selectedTags.length === 1 ? `#${selectedTags[0]}` : "All saves"}
              </h2>
              <p className="library-count">{pluralize(visibleItems.length, "item")}</p>
            </div>
            <div className="density-controls" aria-label="List density">
              <button aria-pressed={density === "compact"} onClick={() => setDensity("compact")} type="button">compact</button>
              <button aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")} type="button">comfortable</button>
            </div>
            <label className="sort-control">
              <span className="sr-only">Sort order</span>
              <select onChange={(event) => setSortMode(event.target.value as SortMode)} value={sortMode}>
                <option value="recent">newest ↓</option>
                <option value="oldest">oldest ↑</option>
                <option value="title">title A–Z</option>
              </select>
            </label>
          </div>

          <QuickAdd busy={busyAction !== null} onAdd={addItem} />

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
            <div className="mobile-filter-heading">
              <strong>Filter library</strong>
              <button onClick={() => setFiltersOpen(false)} type="button">Done</button>
            </div>
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
            <ol className={`item-list item-list-${density}`}>
              {renderedItems.map((item) => (
                <LibraryItem
                  busy={busyAction !== null}
                  item={item}
                  key={item.id}
                  onDelete={deleteItem}
                  onEdit={openEditor}
                  onFavorite={toggleFavorite}
                  onRead={openReader}
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
          <footer className="keyboard-footer">
            <span><b>Ctrl Shift P</b> command</span>
            <span><b>/</b> search</span>
            <span><b>⏎</b> reader</span>
            <span><b>↗</b> open</span>
            <span className="keyboard-footer-note">local-first · private · no tracking</span>
          </footer>
          </section>
        </main>
        <nav aria-label="Mobile actions" className="mobile-actions">
          <button className="primary-button" onClick={(event) => openCapture(event.currentTarget)} type="button">＋ Save a link</button>
          <button className="secondary-button" onClick={() => navigateToView("sync")} type="button">Sync {libraryState.pendingCount}</button>
          <button className="secondary-button" onClick={() => navigateToView("settings")} type="button">Settings</button>
        </nav>
      </div>

      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {undoNotice ? (
        <div className="undo-notice" role="status">
          <span>{undoNotice.message}</span>
          <button
            disabled={busyAction !== null}
            onClick={() => void undoLastChange()}
            type="button"
          >
            Undo
          </button>
          <button
            aria-label="Dismiss undo"
            className="undo-dismiss"
            disabled={busyAction !== null}
            onClick={() => setUndoNotice(null)}
            type="button"
          >
            ×
          </button>
        </div>
      ) : null}

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

      {commandOpen ? (
        <CommandPalette
          items={items.filter((item) => !item.deleted)}
          onClose={() => setCommandOpen(false)}
          onFilterTag={(tag) => {
            navigateToView("library");
            setSelectedTags([tag]);
            setCommandOpen(false);
          }}
          onNewSave={() => {
            setCommandOpen(false);
            setCapturing(true);
          }}
          onOpenItem={(item) => {
            openReader(item);
            setCommandOpen(false);
          }}
          onSync={() => {
            navigateToView("sync");
            setCommandOpen(false);
          }}
          tags={tagCounts}
        />
      ) : null}

      {readerItem ? (
        <ReaderView
          busy={busyAction !== null}
          item={items.find((item) => item.id === readerItem.id) ?? readerItem}
          items={visibleItems}
          onBack={closeReader}
          onDelete={deleteItem}
          onEdit={openEditor}
          onFavorite={toggleFavorite}
          onSelect={(item) => openReader(item, true)}
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
        <h1 id="welcome-heading">
          {restoreFirst
            ? "Bring your library into this browser."
            : "Set up this browser."}
        </h1>
        <p className="welcome-copy">
          No library is stored in this browser yet. Create an empty local library
          or restore one you already use.
        </p>

        {error ? <p role="alert">{error}</p> : null}

        <div className="onboarding-options">
          <button className={!restoreFirst ? "onboarding-choice onboarding-choice-priority" : "onboarding-choice"} disabled={busy} onClick={() => void onInitialize()} type="button">
            <span aria-hidden="true">&gt;</span>
            <span><strong>Create a local library</strong><small>Start empty in this browser. Connect private sync whenever.</small></span>
            <kbd>↵</kbd>
          </button>
          <button className={restoreFirst ? "onboarding-choice onboarding-choice-priority" : "onboarding-choice"} disabled={busy} onClick={() => void onRestore()} type="button">
            <span aria-hidden="true">&gt;</span>
            <span><strong>Restore an existing library</strong><small>Pull the library your CLI or another browser already syncs.</small></span>
            <kbd>R</kbd>
          </button>
        </div>

        <p className="welcome-footnote">
          Restoring first avoids merges. Keep browser storage enabled. <a href="../">Product overview</a>
        </p>
      </section>
    </main>
  );
}

function SettingsPanel({
  density,
  hidden,
  onDensityChange,
  onThemeChange,
  theme,
}: {
  density: Density;
  hidden: boolean;
  onDensityChange: (density: Density) => void;
  onThemeChange: (theme: ThemeColors) => void;
  theme: ThemeColors;
}) {
  const selectedPreset =
    THEME_PRESETS.find(({ colors }) => themesEqual(theme, colors))?.id ?? "custom";

  return (
    <section
      aria-labelledby="settings-heading"
      className="settings-section"
      hidden={hidden}
      id="settings"
    >
      <header className="settings-heading">
        <p className="eyebrow">Workspace</p>
        <h2 id="settings-heading">Settings</h2>
        <p>Preferences stay in this browser and never become library data.</p>
      </header>

      <div className="settings-group">
        <div>
          <h3>Appearance</h3>
          <p>Adjust list density and the colors used by this owner app.</p>
        </div>
        <div className="appearance-settings">
          <label className="setting-row" htmlFor="compact-mode">
            <span>
              <strong>Compact mode</strong>
              <small>Fit more saves on screen by hiding previews and tightening rows.</small>
            </span>
            <input
              checked={density === "compact"}
              id="compact-mode"
              onChange={(event) =>
                onDensityChange(event.target.checked ? "compact" : "comfortable")
              }
              type="checkbox"
            />
          </label>
          <fieldset className="theme-editor">
            <legend>Color theme</legend>
            <p>Choose a preset or customize its core palette. Supporting surfaces and borders adapt automatically.</p>
            <label className="theme-preset" htmlFor="theme-preset">
              <span>
                <strong>Theme preset</strong>
                <small>Start with a familiar editor palette.</small>
              </span>
              <select
                id="theme-preset"
                onChange={(event) => {
                  const preset = THEME_PRESETS.find(
                    ({ id }) => id === event.target.value,
                  );
                  if (preset) onThemeChange({ ...preset.colors });
                }}
                value={selectedPreset}
              >
                {selectedPreset === "custom" ? (
                  <option value="custom">Custom</option>
                ) : null}
                {THEME_PRESETS.map(({ id, label }) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </label>
            <div className="theme-color-grid">
              {THEME_FIELDS.map(({ key, label }) => (
                <label htmlFor={`theme-${key}`} key={key}>
                  <span>{label}</span>
                  <input
                    id={`theme-${key}`}
                    onChange={(event) =>
                      onThemeChange({ ...theme, [key]: event.target.value })
                    }
                    type="color"
                    value={theme[key]}
                  />
                  <code>{theme[key]}</code>
                </label>
              ))}
            </div>
            <button
              className="secondary-button theme-reset"
              disabled={themesEqual(theme, DEFAULT_THEME)}
              onClick={() => onThemeChange({ ...DEFAULT_THEME })}
              type="button"
            >
              Reset to default theme
            </button>
          </fieldset>
        </div>
      </div>

      <div className="settings-group">
        <div>
          <h3>Keyboard</h3>
          <p>Shortcuts are available outside text fields.</p>
        </div>
        <dl className="shortcut-list">
          <div><dt>Command palette</dt><dd><kbd>Ctrl Shift P</kbd></dd></div>
          <div><dt>Search library</dt><dd><kbd>/</kbd></dd></div>
          <div><dt>Close a focused view</dt><dd><kbd>Esc</kbd></dd></div>
        </dl>
      </div>

      <div className="settings-group">
        <div>
          <h3>Local data</h3>
          <p>Your library and this preference remain on this device unless you explicitly connect private sync.</p>
        </div>
        <p className="settings-status"><span aria-hidden="true" className="status-dot" /> Browser storage enabled</p>
      </div>
    </section>
  );
}

function SyncPanel({
  activeItemIds,
  busy,
  hidden,
  onDeletePendingItem,
  pendingChanges,
  state,
}: {
  activeItemIds: ReadonlySet<string>;
  busy: boolean;
  hidden: boolean;
  onDeletePendingItem: (itemId: string) => void;
  pendingChanges: PendingSyncChange[];
  state: BrowserSyncState;
}) {
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  async function connect(event: SubmitEvent<HTMLFormElement>) {
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

  async function unlock(event: SubmitEvent<HTMLFormElement>) {
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
          activeItemIds={activeItemIds}
          changes={pendingChanges}
          hasSynced={Boolean(remote?.lastSuccessAt)}
          mutating={busy}
          onDeleteItem={onDeletePendingItem}
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
  activeItemIds,
  changes,
  hasSynced,
  mutating,
  onDeleteItem,
  syncing,
}: {
  activeItemIds: ReadonlySet<string>;
  changes: PendingSyncChange[];
  hasSynced: boolean;
  mutating: boolean;
  onDeleteItem: (itemId: string) => void;
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
              {change.kind === "create" && change.itemId && activeItemIds.has(change.itemId) ? (
                <button
                  aria-label={`Delete pending item ${change.label}`}
                  className="sync-change-delete"
                  disabled={syncing || mutating}
                  onClick={() => onDeleteItem(change.itemId!)}
                  type="button"
                >
                  Delete item
                </button>
              ) : null}
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

function QuickAdd({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (input: AddInput) => Promise<boolean>;
}) {
  const [value, setValue] = useState("");

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const parts = value.trim().split(/\s+/);
    const url = parts.find((part) => !part.startsWith("#")) ?? "";
    const tags = parts
      .filter((part) => part.startsWith("#") && part.length > 1)
      .map((part) => part.slice(1));
    if (!url) return;
    if (await onAdd({ favorite: false, tags, url } as AddInput)) setValue("");
  }

  return (
    <form className="quick-add" onSubmit={(event) => void submit(event)}>
      <span aria-hidden="true">+</span>
      <label className="sr-only" htmlFor="quick-add-url">Quickly save a URL</label>
      <input
        autoCapitalize="none"
        autoComplete="url"
        disabled={busy}
        id="quick-add-url"
        inputMode="url"
        onChange={(event) => setValue(event.target.value)}
        placeholder="Paste or type a URL — ↵ saves it. Add #tags right here."
        type="text"
        value={value}
      />
      <span className="quick-add-hint">or ⌘V anywhere</span>
    </form>
  );
}

function CommandPalette({
  items,
  onClose,
  onFilterTag,
  onNewSave,
  onOpenItem,
  onSync,
  tags,
}: {
  items: LibraryItemView[];
  onClose: () => void;
  onFilterTag: (tag: string) => void;
  onNewSave: () => void;
  onOpenItem: (item: LibraryItemView) => void;
  onSync: () => void;
  tags: { count: number; tag: string }[];
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const matchingTags = tags
    .filter(({ tag }) => !normalized || tag.toLocaleLowerCase().includes(normalized))
    .slice(0, 5);
  const matchingItems = items
    .filter((item) =>
      !normalized || [item.title, item.url, ...item.tags]
        .filter(Boolean)
        .some((value) => value!.toLocaleLowerCase().includes(normalized)),
    )
    .slice(0, 6);
  const optionCount = matchingTags.length + matchingItems.length + 2;

  function runOption(index: number) {
    if (index < matchingTags.length) {
      onFilterTag(matchingTags[index]!.tag);
      return;
    }

    const itemIndex = index - matchingTags.length;
    if (itemIndex < matchingItems.length) {
      onOpenItem(matchingItems[itemIndex]!);
      return;
    }

    if (itemIndex === matchingItems.length) onSync();
    else onNewSave();
  }

  function moveSelection(offset: number) {
    setActiveIndex((current) => (current + offset + optionCount) % optionCount);
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    document
      .getElementById(`command-option-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <dialog
      aria-label="Search or run a command"
      className="command-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={dialogRef}
    >
      <div className="command-input">
        <span aria-hidden="true">&gt;</span>
        <input
          aria-activedescendant={`command-option-${activeIndex}`}
          aria-controls="command-results"
          aria-expanded="true"
          aria-label="Search saves, tags, and commands"
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
                event.key.toLocaleLowerCase() === "n") ||
              event.key === "ArrowDown"
            ) {
              event.preventDefault();
              moveSelection(1);
            } else if (
              (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
                event.key.toLocaleLowerCase() === "p") ||
              event.key === "ArrowUp"
            ) {
              event.preventDefault();
              moveSelection(-1);
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              runOption(activeIndex);
            }
          }}
          placeholder="Search saves, tags, and commands"
          role="combobox"
          value={query}
        />
      </div>
      <div className="command-results" id="command-results" role="listbox">
        {matchingTags.length > 0 ? <p role="presentation">Tags</p> : null}
        {matchingTags.map(({ count, tag }, index) => (
          <button aria-selected={activeIndex === index} className={activeIndex === index ? "command-selected" : undefined} id={`command-option-${index}`} key={tag} onClick={() => onFilterTag(tag)} onPointerEnter={() => setActiveIndex(index)} role="option" type="button">
            <span>#{tag}</span><small>{pluralize(count, "save")}</small><em>↵ filter library</em>
          </button>
        ))}
        {matchingItems.length > 0 ? <p role="presentation">Saves</p> : null}
        {matchingItems.map((item, itemIndex) => {
          const index = matchingTags.length + itemIndex;
          return <button aria-selected={activeIndex === index} className={activeIndex === index ? "command-selected" : undefined} id={`command-option-${index}`} key={item.id} onClick={() => onOpenItem(item)} onPointerEnter={() => setActiveIndex(index)} role="option" type="button">
            <strong>{item.title?.trim() || item.url}</strong>
            <small>{readHostname(item.url)}</small>
            <em>{item.tags.map((tag) => `#${tag}`).join(" ")}</em>
          </button>;
        })}
        <p role="presentation">Actions</p>
        <button aria-selected={activeIndex === optionCount - 2} className={activeIndex === optionCount - 2 ? "command-selected" : undefined} id={`command-option-${optionCount - 2}`} onClick={onSync} onPointerEnter={() => setActiveIndex(optionCount - 2)} role="option" type="button"><span>Sync</span><em>open status</em></button>
        <button aria-selected={activeIndex === optionCount - 1} className={activeIndex === optionCount - 1 ? "command-selected" : undefined} id={`command-option-${optionCount - 1}`} onClick={onNewSave} onPointerEnter={() => setActiveIndex(optionCount - 1)} role="option" type="button"><span>Save a URL</span><em>new save</em></button>
      </div>
      <footer className="command-footer"><span><b>Ctrl P/N · ↑↓</b> navigate</span><span><b>↵</b> select</span><span><b>esc</b> close</span></footer>
    </dialog>
  );
}

function ReaderView({
  busy,
  item,
  items,
  onBack,
  onDelete,
  onEdit,
  onFavorite,
  onSelect,
}: {
  busy: boolean;
  item: LibraryItemView;
  items: LibraryItemView[];
  onBack: () => void;
  onDelete: (item: LibraryItemView) => Promise<void>;
  onEdit: (item: LibraryItemView, opener: HTMLButtonElement) => void;
  onFavorite: (item: LibraryItemView) => Promise<void>;
  onSelect: (item: LibraryItemView) => void;
}) {
  const label = item.title?.trim() || item.url;
  const context = item.excerpt;
  const hasContext = Boolean(context?.trim());

  return (
    <div className="reader-view" role="dialog" aria-modal="true" aria-labelledby="reader-title">
      <aside className="reader-list">
        <header><button onClick={onBack} type="button">← All saves</button><span>{items.length}</span></header>
        <ol>
          {items.map((candidate) => (
            <li className={candidate.id === item.id ? "reader-selected" : undefined} key={candidate.id}>
              <button onClick={() => onSelect(candidate)} type="button">
                <strong>{candidate.title?.trim() || candidate.url}</strong>
                <span>{readHostname(candidate.url)} · {formatDate(candidate.savedAt)}</span>
              </button>
            </li>
          ))}
        </ol>
        <footer><span><b>j/k</b> next</span><span><b>esc</b> back</span></footer>
      </aside>
      <article className="reader-article">
        <header className="reader-mobile-header">
          <button aria-label="Back to all saves" onClick={onBack} type="button">←</button>
          <span>{readHostname(item.url)}</span>
        </header>
        <div className="reader-content">
          <div className="reader-meta">
            <span>{readHostname(item.url)} · Saved {formatDate(item.savedAt)}</span>
            <div>
              <button aria-label={item.favorite ? "Remove favorite" : "Favorite"} disabled={busy} onClick={() => void onFavorite(item)} type="button">★</button>
              <button aria-haspopup="dialog" aria-label="Edit save" disabled={busy} onClick={(event) => onEdit(item, event.currentTarget)} type="button">✎</button>
              <a aria-label="Open original" href={item.url} rel="noreferrer" target="_blank">↗</a>
              <button aria-label="Archive" disabled={busy} onClick={() => void onDelete(item).then(onBack)} type="button">⌫</button>
            </div>
          </div>
          <h1 id="reader-title">{label}</h1>
          {item.tags.length > 0 ? <p className="reader-tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</p> : null}
          {item.note?.trim() ? <aside className="reader-note"><strong>Your note</strong><p>{item.note}</p></aside> : null}
          <div className="reader-body">
            {hasContext && context ? <MarkdownDocument source={context} /> : <p>This save has no extracted preview yet. Open the original to read the full page, or add a private note to keep the context that matters.</p>}
            <p className="reader-source">ResearchPocket keeps the URL and your authored context locally. The original page remains at <a href={item.url} rel="noreferrer" target="_blank">{readHostname(item.url)}</a>.</p>
          </div>
        </div>
      </article>
    </div>
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

  async function submit(event: SubmitEvent<HTMLFormElement>) {
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
  onFavorite,
  onRead,
  onRestore,
  onToggleTagFilter,
  selectedTags,
}: {
  busy: boolean;
  item: LibraryItemView;
  onDelete: (item: LibraryItemView) => Promise<void>;
  onEdit: (item: LibraryItemView, opener: HTMLButtonElement) => void;
  onFavorite: (item: LibraryItemView) => Promise<void>;
  onRead: (item: LibraryItemView) => void;
  onRestore: (item: LibraryItemView) => Promise<void>;
  onToggleTagFilter: (tag: string) => void;
  selectedTags: string[];
}) {
  const label = item.title?.trim() || item.url;
  const preview = item.note?.trim() || item.excerpt?.trim();

  return (
    <li>
      <article
        className={`item-card${
          item.deleted ? " item-card-deleted" : " item-card-editable"
        }${item.favorite ? " item-card-favorite" : ""}`}
      >
        <button
          aria-label={item.favorite ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
          aria-pressed={item.favorite}
          className="item-favorite"
          disabled={busy || item.deleted}
          onClick={() => void onFavorite(item)}
          title={item.favorite ? "Remove favorite" : "Favorite"}
          type="button"
        >
          <span aria-hidden="true">{item.favorite ? "★" : "·"}</span>
        </button>
        {!item.deleted ? (
          <button
            aria-label={`Read ${label}${item.favorite ? ", favorite" : ""}`}
            className="item-card-edit-trigger"
            disabled={busy}
            onClick={() => onRead(item)}
            title="Open reader"
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
            {item.tags.length > 0 ? (
              <span
                aria-label={`Tags for ${label}`}
                className="item-inline-tags"
                role="group"
              >
                {item.tags.map((tag) => {
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
              <button
                aria-label={`Read ${label}`}
                className="icon-button"
                disabled={busy}
                onClick={() => onRead(item)}
                title="Reader"
                type="button"
              >
                <span aria-hidden="true">¶</span>
              </button>
              <button
                aria-haspopup="dialog"
                aria-label={`Edit ${label}`}
                className="icon-button"
                disabled={busy}
                onClick={(event) => onEdit(item, event.currentTarget)}
                title="Edit"
                type="button"
              >
                <span aria-hidden="true">✎</span>
              </button>
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
                <span aria-hidden="true">⌫</span>
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

  async function submit(event: SubmitEvent<HTMLFormElement>) {
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

function readWorkspaceView(): WorkspaceView {
  if (
    window.location.hash === "#sync" ||
    window.location.hash === "#restore"
  ) {
    return "sync";
  }
  return window.location.hash === "#settings" ? "settings" : "library";
}

function readDensityPreference(): Density {
  try {
    return window.localStorage.getItem(DENSITY_STORAGE_KEY) === "compact"
      ? "compact"
      : "comfortable";
  } catch {
    return "comfortable";
  }
}

function readThemePreference(): ThemeColors {
  try {
    const stored = JSON.parse(window.localStorage.getItem(THEME_STORAGE_KEY) ?? "null");
    if (stored?.version === 1 && isThemeColors(stored.colors)) {
      return stored.colors;
    }
  } catch {
    // Invalid or unavailable storage falls back to the shipped theme.
  }
  return { ...DEFAULT_THEME };
}

function isThemeColors(value: unknown): value is ThemeColors {
  if (!value || typeof value !== "object") return false;
  const colors = value as Record<string, unknown>;
  return THEME_FIELDS.every(
    ({ key }) => typeof colors[key] === "string" && /^#[0-9a-f]{6}$/i.test(colors[key]),
  );
}

function themesEqual(left: ThemeColors, right: ThemeColors) {
  return THEME_FIELDS.every(({ key }) => left[key] === right[key]);
}

function applyThemePreference(theme: ThemeColors) {
  const root = document.documentElement;
  const derivedProperties = {
    "--color-surface": "color-mix(in srgb, var(--background) 92%, var(--text))",
    "--color-surface-raised": "color-mix(in srgb, var(--background) 89%, var(--text))",
    "--color-surface-muted": "color-mix(in srgb, var(--background) 86%, var(--text))",
    "--color-text-muted": "color-mix(in srgb, var(--text) 55%, var(--background))",
    "--color-text-soft": "color-mix(in srgb, var(--text) 72%, var(--background))",
    "--color-text-reader": "color-mix(in srgb, var(--text) 88%, var(--background))",
    "--color-favorite-muted": "color-mix(in srgb, var(--text) 34%, var(--background))",
    "--color-border": "color-mix(in srgb, var(--text) 20%, var(--background))",
    "--color-border-subtle": "color-mix(in srgb, var(--text) 9%, var(--background))",
    "--color-border-strong": "color-mix(in srgb, var(--text) 38%, var(--background))",
    "--color-accent-soft": "color-mix(in srgb, var(--secondary) 28%, var(--background))",
    "--color-reader-note": "color-mix(in srgb, var(--background) 94%, var(--text))",
  };
  const custom = !themesEqual(theme, DEFAULT_THEME);

  for (const { key } of THEME_FIELDS) {
    if (custom) root.style.setProperty(`--${key}`, theme[key]);
    else root.style.removeProperty(`--${key}`);
  }
  for (const [property, value] of Object.entries(derivedProperties)) {
    if (custom) root.style.setProperty(property, value);
    else root.style.removeProperty(property);
  }

  if (custom) root.style.colorScheme = prefersLightControls(theme.background) ? "light" : "dark";
  else root.style.removeProperty("color-scheme");
}

function prefersLightControls(color: string) {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 160;
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
