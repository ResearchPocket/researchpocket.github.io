import overviewSource from "../../../docs/guide/INDEX.md?raw";
import gettingStartedSource from "../../../docs/guide/GETTING_STARTED.md?raw";
import hostedOwnerSource from "../../../docs/guide/BROWSER.md?raw";
import librarySource from "../../../docs/guide/LIBRARY.md?raw";
import zenSource from "../../../docs/guide/ZEN.md?raw";
import referencesSource from "../../../docs/guide/REFERENCES.md?raw";
import readingSource from "../../../docs/guide/READING.md?raw";
import syncSource from "../../../docs/guide/SYNC.md?raw";
import cliSource from "../../../docs/v2/CLI.md?raw";
import migrationSource from "../../../docs/v2/MIGRATION.md?raw";
import dataAndPrivacySource from "../../../docs/v2/DATA_AND_PRIVACY.md?raw";
import technicalSource from "../../../docs/guide/TECHNICAL.md?raw";
import webArchitectureSource from "../../../docs/v2/WEB.md?raw";
import syncProtocolSource from "../../../docs/v2/SYNC_PROTOCOL.md?raw";
import threatModelSource from "../../../docs/v2/THREAT_MODEL.md?raw";
import designSystemSource from "../../../docs/v2/DESIGN_SYSTEM.md?raw";
import productSource from "../../../docs/v2/PRODUCT.md?raw";
import roadmapSource from "../../../docs/v2/ROADMAP.md?raw";
import contributingSource from "../../../CONTRIBUTING.md?raw";
import adrNativeCaptureSource from "../../../docs/v2/ADR_0001_NATIVE_BROWSER_CAPTURE.md?raw";
import adrEnrichmentSource from "../../../docs/v2/ADR_0002_LINK_ENRICHMENT.md?raw";
import adrOperationPacksSource from "../../../docs/v2/ADR_0003_OPERATION_PACKS.md?raw";
import adrFirecrawlMarkdownSource from "../../../docs/v2/ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md?raw";
import adrUndoSource from "../../../docs/v2/ADR_0005_COMPENSATING_UNDO.md?raw";
import adrStagedParitySource from "../../../docs/v2/ADR_0006_STAGED_V2_PARITY.md?raw";
import adrCargoPublicationSource from "../../../docs/v2/ADR_0007_CARGO_WORKSPACE_PUBLICATION.md?raw";
import adrMergedExcerptSource from "../../../docs/v2/ADR_0008_EXCERPT_AS_MERGED_TEXT.md?raw";
import adrMarkdownImagesSource from "../../../docs/v2/ADR_0009_OPT_IN_MARKDOWN_IMAGES.md?raw";
import adrBoundedSyncSource from "../../../docs/v2/ADR_0010_BOUNDED_ITEM_SCOPED_SYNC.md?raw";
import adrZenSource from "../../../docs/v2/ADR_0011_ZEN_DOCUMENTS.md?raw";
import adrLibraryGraphSource from "../../../docs/v2/ADR_0012_DERIVED_LIBRARY_GRAPH.md?raw";
import adrBrowserTokenSource from "../../../docs/v2/ADR_0013_REMEMBER_BROWSER_TOKEN.md?raw";
import adrZenLinksSource from "../../../docs/v2/ADR_0014_ZEN_LINK_COMPLETION.md?raw";
import releaseSource from "../../../docs/releases/v2.3.0.md?raw";
import release222Source from "../../../docs/releases/v2.2.2.md?raw";
import release221Source from "../../../docs/releases/v2.2.1.md?raw";
import release211Source from "../../../docs/releases/v2.1.1.md?raw";
import release210Source from "../../../docs/releases/v2.1.0.md?raw";
import release201Source from "../../../docs/releases/v2.0.1.md?raw";
import release200Source from "../../../docs/releases/v2.0.0.md?raw";
import releasePreview4Source from "../../../docs/releases/v2.0.0-preview.4.md?raw";
import releasePreview3Source from "../../../docs/releases/v2.0.0-preview.3.md?raw";
import releasePreview2Source from "../../../docs/releases/v2.0.0-preview.2.md?raw";
import releasePreview1Source from "../../../docs/releases/v2.0.0-preview.1.md?raw";

export const DOCS_VERSION = "2.3.0";

export interface ReferenceSection {
  id: string;
  label: string;
  collapsible?: boolean;
}

export interface ReferenceDocument {
  description: string;
  id: string;
  section: string;
  source: string;
  sourcePath: string;
  title: string;
}

export const referenceSections: ReferenceSection[] = [
  { id: "start", label: "Get started" },
  { id: "guides", label: "Everyday use" },
  { id: "reference", label: "Reference" },
  { id: "technical", label: "Under the hood", collapsible: true },
  { id: "decisions", label: "Architecture decisions", collapsible: true },
  { id: "release", label: "Latest release" },
  { id: "release-archive", label: "Earlier releases", collapsible: true },
];

export const referenceDocuments: ReferenceDocument[] = [
  {
    id: "overview",
    section: "start",
    title: "Documentation",
    description: "Find your way around ResearchPocket 2.3: saved URLs, Zen documents, references, reading, and private sync.",
    sourcePath: "docs/guide/INDEX.md",
    source: overviewSource,
  },
  {
    id: "getting-started",
    section: "start",
    title: "Getting started",
    description: "Create a browser library or install the CLI, save your first source, and try Zen.",
    sourcePath: "docs/guide/GETTING_STARTED.md",
    source: gettingStartedSource,
  },
  {
    id: "hosted-owner",
    section: "start",
    title: "Browser workspace",
    description: "Navigate Zen, Library, Graph, Sync, profiles, offline work, and trusted-browser tokens.",
    sourcePath: "docs/guide/BROWSER.md",
    source: hostedOwnerSource,
  },
  {
    id: "library",
    section: "guides",
    title: "Save and organize sources",
    description: "Capture URLs, curate notes and tags, search, explore the graph, and restore deleted saves.",
    sourcePath: "docs/guide/LIBRARY.md",
    source: librarySource,
  },
  {
    id: "zen",
    section: "guides",
    title: "Zen documents",
    description: "Write Markdown, toggle todos, reference saved items, and edit documents in the browser, CLI, and TUI.",
    sourcePath: "docs/guide/ZEN.md",
    source: zenSource,
  },
  {
    id: "references",
    section: "guides",
    title: "Documentation and references",
    description: "Organize technical documentation and research sources, build reading plans, and connect sources with item mentions.",
    sourcePath: "docs/guide/REFERENCES.md",
    source: referencesSource,
  },
  {
    id: "reading",
    section: "guides",
    title: "Capture and reading",
    description: "Install browser capture, enrich metadata, read captured Markdown, and manage page content.",
    sourcePath: "docs/guide/READING.md",
    source: readingSource,
  },
  {
    id: "sync",
    section: "guides",
    title: "Sync and recovery",
    description: "Connect private GitHub sync, restore another device, and recover from failed cycles without losing queued work.",
    sourcePath: "docs/guide/SYNC.md",
    source: syncSource,
  },
  {
    id: "cli",
    section: "reference",
    title: "CLI and TUI",
    description: "Exact commands, options, shortcuts, and machine-readable output for saves, documents, capture, and sync.",
    sourcePath: "docs/v2/CLI.md",
    source: cliSource,
  },
  {
    id: "migration",
    section: "reference",
    title: "Move from V1",
    description: "Import an existing V1 SQLite library without changing the source database.",
    sourcePath: "docs/v2/MIGRATION.md",
    source: migrationSource,
  },
  {
    id: "data-and-privacy",
    section: "reference",
    title: "Data, sync, and privacy",
    description: "Local storage, credential retention, enrichment privacy, remote history, backups, and recovery.",
    sourcePath: "docs/v2/DATA_AND_PRIVACY.md",
    source: dataAndPrivacySource,
  },
  {
    id: "technical",
    section: "technical",
    title: "Technical reference",
    description: "Find implementation contracts, architecture decisions, product scope, and contributor guidance.",
    sourcePath: "docs/guide/TECHNICAL.md",
    source: technicalSource,
  },
  {
    id: "web-architecture",
    section: "technical",
    title: "Browser architecture",
    description: "Static shell, IndexedDB persistence, offline caching, CSP, and owner synchronization lifecycle.",
    sourcePath: "docs/v2/WEB.md",
    source: webArchitectureSource,
  },
  {
    id: "sync-protocol",
    section: "technical",
    title: "Sync protocol",
    description: "Immutable envelopes, operation packs, checkpoints, aggregate generations, and compatibility.",
    sourcePath: "docs/v2/SYNC_PROTOCOL.md",
    source: syncProtocolSource,
  },
  {
    id: "threat-model",
    section: "technical",
    title: "Threat model",
    description: "Trust boundaries, repository access, credentials, captured content, and residual risks.",
    sourcePath: "docs/v2/THREAT_MODEL.md",
    source: threatModelSource,
  },
  {
    id: "design-system",
    section: "technical",
    title: "Design system",
    description: "Visual tokens, typography, components, accessibility, and interface constraints.",
    sourcePath: "docs/v2/DESIGN_SYSTEM.md",
    source: designSystemSource,
  },
  {
    id: "product",
    section: "technical",
    title: "Product contract",
    description: "Product principles and target workflows, including capabilities that remain planned.",
    sourcePath: "docs/v2/PRODUCT.md",
    source: productSource,
  },
  {
    id: "roadmap",
    section: "technical",
    title: "Roadmap",
    description: "Delivery phases, planned work, project metadata, and completion criteria.",
    sourcePath: "docs/v2/ROADMAP.md",
    source: roadmapSource,
  },
  {
    id: "contributing",
    section: "technical",
    title: "Contributing",
    description: "Development setup, verification, issue workflow, and pull-request expectations.",
    sourcePath: "CONTRIBUTING.md",
    source: contributingSource,
  },
  {
    id: "adr-native-capture",
    section: "decisions",
    title: "0001: Native browser capture",
    description: "Architecture decision 0001: native browser capture. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0001_NATIVE_BROWSER_CAPTURE.md",
    source: adrNativeCaptureSource,
  },
  {
    id: "adr-enrichment",
    section: "decisions",
    title: "0002: Link enrichment",
    description: "Architecture decision 0002: link enrichment. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0002_LINK_ENRICHMENT.md",
    source: adrEnrichmentSource,
  },
  {
    id: "adr-operation-packs",
    section: "decisions",
    title: "0003: Operation packs",
    description: "Architecture decision 0003: operation packs. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0003_OPERATION_PACKS.md",
    source: adrOperationPacksSource,
  },
  {
    id: "adr-firecrawl-markdown",
    section: "decisions",
    title: "0004: Captured Markdown",
    description: "Architecture decision 0004: captured markdown. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md",
    source: adrFirecrawlMarkdownSource,
  },
  {
    id: "adr-undo",
    section: "decisions",
    title: "0005: Compensating undo",
    description: "Architecture decision 0005: compensating undo. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0005_COMPENSATING_UNDO.md",
    source: adrUndoSource,
  },
  {
    id: "adr-staged-parity",
    section: "decisions",
    title: "0006: Staged V2 parity",
    description: "Architecture decision 0006: staged v2 parity. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0006_STAGED_V2_PARITY.md",
    source: adrStagedParitySource,
  },
  {
    id: "adr-cargo-publication",
    section: "decisions",
    title: "0007: Cargo publication",
    description: "Architecture decision 0007: cargo publication. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0007_CARGO_WORKSPACE_PUBLICATION.md",
    source: adrCargoPublicationSource,
  },
  {
    id: "adr-merged-excerpt",
    section: "decisions",
    title: "0008: Merged excerpts",
    description: "Architecture decision 0008: merged excerpts. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0008_EXCERPT_AS_MERGED_TEXT.md",
    source: adrMergedExcerptSource,
  },
  {
    id: "adr-markdown-images",
    section: "decisions",
    title: "0009: Opt-in images",
    description: "Architecture decision 0009: opt-in images. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0009_OPT_IN_MARKDOWN_IMAGES.md",
    source: adrMarkdownImagesSource,
  },
  {
    id: "adr-bounded-sync",
    section: "decisions",
    title: "0010: Bounded sync design",
    description: "Architecture decision 0010: bounded sync design. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0010_BOUNDED_ITEM_SCOPED_SYNC.md",
    source: adrBoundedSyncSource,
  },
  {
    id: "adr-zen",
    section: "decisions",
    title: "0011: Zen documents",
    description: "Architecture decision 0011: zen documents. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0011_ZEN_DOCUMENTS.md",
    source: adrZenSource,
  },
  {
    id: "adr-library-graph",
    section: "decisions",
    title: "0012: Derived library graph",
    description: "Architecture decision 0012: derived library graph. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0012_DERIVED_LIBRARY_GRAPH.md",
    source: adrLibraryGraphSource,
  },
  {
    id: "adr-browser-token",
    section: "decisions",
    title: "0013: Remember browser token",
    description: "Architecture decision 0013: remember browser token. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0013_REMEMBER_BROWSER_TOKEN.md",
    source: adrBrowserTokenSource,
  },
  {
    id: "adr-zen-links",
    section: "decisions",
    title: "0014: Zen links and backlinks",
    description: "Architecture decision 0014: zen links and backlinks. Historical design context; see user guides for shipped behavior.",
    sourcePath: "docs/v2/ADR_0014_ZEN_LINK_COMPLETION.md",
    source: adrZenLinksSource,
  },
  {
    id: "release",
    section: "release",
    title: "ResearchPocket 2.3.0",
    description: "Current release: TUI documents, remembered browser tokens, separate captured pages, and upgrade notes.",
    sourcePath: "docs/releases/v2.3.0.md",
    source: releaseSource,
  },
  {
    id: "release-2-2-2",
    section: "release-archive",
    title: "ResearchPocket 2.2.2",
    description: "Historical release notes and compatibility information for 2.2.2.",
    sourcePath: "docs/releases/v2.2.2.md",
    source: release222Source,
  },
  {
    id: "release-2-2-1",
    section: "release-archive",
    title: "ResearchPocket 2.2.1",
    description: "Historical release notes and compatibility information for 2.2.1.",
    sourcePath: "docs/releases/v2.2.1.md",
    source: release221Source,
  },
  {
    id: "release-2-1-1",
    section: "release-archive",
    title: "ResearchPocket 2.1.1",
    description: "Historical release notes and compatibility information for 2.1.1.",
    sourcePath: "docs/releases/v2.1.1.md",
    source: release211Source,
  },
  {
    id: "release-2-1-0",
    section: "release-archive",
    title: "ResearchPocket 2.1.0",
    description: "Historical release notes and compatibility information for 2.1.0.",
    sourcePath: "docs/releases/v2.1.0.md",
    source: release210Source,
  },
  {
    id: "release-2-0-1",
    section: "release-archive",
    title: "ResearchPocket 2.0.1",
    description: "Historical release notes and compatibility information for 2.0.1.",
    sourcePath: "docs/releases/v2.0.1.md",
    source: release201Source,
  },
  {
    id: "release-2-0-0",
    section: "release-archive",
    title: "ResearchPocket 2.0.0",
    description: "Historical release notes and compatibility information for 2.0.0.",
    sourcePath: "docs/releases/v2.0.0.md",
    source: release200Source,
  },
  {
    id: "release-preview-4",
    section: "release-archive",
    title: "ResearchPocket 2.0.0-preview.4",
    description: "Historical release notes and compatibility information for 2.0.0-preview.4.",
    sourcePath: "docs/releases/v2.0.0-preview.4.md",
    source: releasePreview4Source,
  },
  {
    id: "release-preview-3",
    section: "release-archive",
    title: "ResearchPocket 2.0.0-preview.3",
    description: "Historical release notes and compatibility information for 2.0.0-preview.3.",
    sourcePath: "docs/releases/v2.0.0-preview.3.md",
    source: releasePreview3Source,
  },
  {
    id: "release-preview-2",
    section: "release-archive",
    title: "ResearchPocket 2.0.0-preview.2",
    description: "Historical release notes and compatibility information for 2.0.0-preview.2.",
    sourcePath: "docs/releases/v2.0.0-preview.2.md",
    source: releasePreview2Source,
  },
  {
    id: "release-preview-1",
    section: "release-archive",
    title: "ResearchPocket 2.0.0-preview.1",
    description: "Historical release notes and compatibility information for 2.0.0-preview.1.",
    sourcePath: "docs/releases/v2.0.0-preview.1.md",
    source: releasePreview1Source,
  }
];

export const referenceDocumentById = new Map(
  referenceDocuments.map((document) => [document.id, document]),
);

export const referenceDocumentBySourcePath = new Map(
  referenceDocuments.map((document) => [document.sourcePath, document]),
);
