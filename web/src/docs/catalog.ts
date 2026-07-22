import contributingSource from "../../../CONTRIBUTING.md?raw";
import overviewSource from "../../../README.md?raw";
import releasePreview2Source from "../../../docs/releases/v2.0.0-preview.2.md?raw";
import releasePreview3Source from "../../../docs/releases/v2.0.0-preview.3.md?raw";
import releasePreview4Source from "../../../docs/releases/v2.0.0-preview.4.md?raw";
import adrNativeCaptureSource from "../../../docs/v2/ADR_0001_NATIVE_BROWSER_CAPTURE.md?raw";
import adrEnrichmentSource from "../../../docs/v2/ADR_0002_LINK_ENRICHMENT.md?raw";
import adrOperationPacksSource from "../../../docs/v2/ADR_0003_OPERATION_PACKS.md?raw";
import adrFirecrawlMarkdownSource from "../../../docs/v2/ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md?raw";
import adrUndoSource from "../../../docs/v2/ADR_0005_COMPENSATING_UNDO.md?raw";
import cliSource from "../../../docs/v2/CLI.md?raw";
import designSystemSource from "../../../docs/v2/DESIGN_SYSTEM.md?raw";
import migrationSource from "../../../docs/v2/MIGRATION.md?raw";
import productSource from "../../../docs/v2/PRODUCT.md?raw";
import roadmapSource from "../../../docs/v2/ROADMAP.md?raw";
import syncProtocolSource from "../../../docs/v2/SYNC_PROTOCOL.md?raw";
import threatModelSource from "../../../docs/v2/THREAT_MODEL.md?raw";
import webSource from "../../../docs/v2/WEB.md?raw";

export interface ReferenceSection {
  id: string;
  label: string;
}

export interface ReferenceDocument {
  description: string;
  id: string;
  section: string;
  source: string;
  sourcePath: string;
  status: string;
  title: string;
}

export const referenceSections: ReferenceSection[] = [
  { id: "start", label: "Start here" },
  { id: "guides", label: "Use ResearchPocket" },
  { id: "reference", label: "Architecture and security" },
  { id: "decisions", label: "Architecture decisions" },
  { id: "project", label: "Project" },
  { id: "releases", label: "Release archive" },
];

export const referenceDocuments: ReferenceDocument[] = [
  {
    description: "Choose an interface, create a library, save your first link, and add optional capture, enrichment, or private sync.",
    id: "overview",
    section: "start",
    source: overviewSource,
    sourcePath: "README.md",
    status: "Current",
    title: "Getting started",
  },
  {
    description: "Complete command, option, capture, enrichment, TUI, synchronization, and output reference.",
    id: "cli",
    section: "guides",
    source: cliSource,
    sourcePath: "docs/v2/CLI.md",
    status: "Current",
    title: "CLI reference",
  },
  {
    description: "Import a V1 library without mutating the source and verify authored-field preservation.",
    id: "migration",
    section: "guides",
    source: migrationSource,
    sourcePath: "docs/v2/MIGRATION.md",
    status: "Current",
    title: "V1 migration",
  },
  {
    description: "Hosted owner application, browser persistence, offline boundary, and synchronization lifecycle.",
    id: "hosted-owner",
    section: "guides",
    source: webSource,
    sourcePath: "docs/v2/WEB.md",
    status: "Current",
    title: "Hosted owner app",
  },
  {
    description: "The product vision, use cases, required surfaces, success criteria, and explicit non-goals.",
    id: "product",
    section: "reference",
    source: productSource,
    sourcePath: "docs/v2/PRODUCT.md",
    status: "Canonical",
    title: "Product contract",
  },
  {
    description: "Normative immutable update, operation-pack, convergence, checkpoint, and recovery protocol.",
    id: "sync-protocol",
    section: "reference",
    source: syncProtocolSource,
    sourcePath: "docs/v2/SYNC_PROTOCOL.md",
    status: "Normative",
    title: "Synchronization protocol",
  },
  {
    description: "Privacy goals, trust boundaries, credential handling, data flows, and threat mitigations.",
    id: "threat-model",
    section: "reference",
    source: threatModelSource,
    sourcePath: "docs/v2/THREAT_MODEL.md",
    status: "Canonical",
    title: "Privacy threat model",
  },
  {
    description: "Canonical visual language, interaction patterns, accessibility, and deployment rules.",
    id: "design-system",
    section: "reference",
    source: designSystemSource,
    sourcePath: "docs/v2/DESIGN_SYSTEM.md",
    status: "Canonical",
    title: "Design system",
  },
  {
    description: "Native browser capture through a versioned, provider-neutral invocation bridge.",
    id: "adr-native-capture",
    section: "decisions",
    source: adrNativeCaptureSource,
    sourcePath: "docs/v2/ADR_0001_NATIVE_BROWSER_CAPTURE.md",
    status: "Accepted",
    title: "ADR 0001 · Native capture",
  },
  {
    description: "Retryable direct and Firecrawl metadata enrichment after durable local capture.",
    id: "adr-enrichment",
    section: "decisions",
    source: adrEnrichmentSource,
    sourcePath: "docs/v2/ADR_0002_LINK_ENRICHMENT.md",
    status: "Accepted",
    title: "ADR 0002 · Link enrichment",
  },
  {
    description: "Transport many exact synchronization envelopes in one immutable bounded pack.",
    id: "adr-operation-packs",
    section: "decisions",
    source: adrOperationPacksSource,
    sourcePath: "docs/v2/ADR_0003_OPERATION_PACKS.md",
    status: "Accepted",
    title: "ADR 0003 · Operation packs",
  },
  {
    description: "Retain bounded Firecrawl Markdown in the convergent excerpt register.",
    id: "adr-firecrawl-markdown",
    section: "decisions",
    source: adrFirecrawlMarkdownSource,
    sourcePath: "docs/v2/ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md",
    status: "Accepted",
    title: "ADR 0004 · Firecrawl Markdown",
  },
  {
    description: "Undo browser actions through convergence-safe compensating mutations.",
    id: "adr-undo",
    section: "decisions",
    source: adrUndoSource,
    sourcePath: "docs/v2/ADR_0005_COMPENSATING_UNDO.md",
    status: "Accepted",
    title: "ADR 0005 · Compensating undo",
  },
  {
    description: "Contribution workflow, repository conventions, toolchain, and required local checks.",
    id: "contributing",
    section: "project",
    source: contributingSource,
    sourcePath: "CONTRIBUTING.md",
    status: "Current",
    title: "Contributing",
  },
  {
    description: "Ordered V2 delivery phases, dependencies, acceptance gates, and planned work.",
    id: "roadmap",
    section: "project",
    source: roadmapSource,
    sourcePath: "docs/v2/ROADMAP.md",
    status: "Planned",
    title: "Delivery roadmap",
  },
  {
    description: "Current preview release notes, operation-pack upgrade requirements, and downloads.",
    id: "release-preview-4",
    section: "releases",
    source: releasePreview4Source,
    sourcePath: "docs/releases/v2.0.0-preview.4.md",
    status: "Latest release",
    title: "v2.0.0-preview.4",
  },
  {
    description: "Historical preview notes for enrichment, native capture, and hosted owner editing.",
    id: "release-preview-3",
    section: "releases",
    source: releasePreview3Source,
    sourcePath: "docs/releases/v2.0.0-preview.3.md",
    status: "Historical",
    title: "v2.0.0-preview.3",
  },
  {
    description: "Historical preview notes for the first published V2 migration and sync release.",
    id: "release-preview-2",
    section: "releases",
    source: releasePreview2Source,
    sourcePath: "docs/releases/v2.0.0-preview.2.md",
    status: "Historical",
    title: "v2.0.0-preview.2",
  },
];

export const referenceDocumentById = new Map(
  referenceDocuments.map((document) => [document.id, document]),
);

export const referenceDocumentBySourcePath = new Map(
  referenceDocuments.map((document) => [document.sourcePath, document]),
);
