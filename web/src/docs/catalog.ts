import overviewSource from "../../../README.md?raw";
import releaseSource from "../../../docs/releases/v2.0.1.md?raw";
import cliSource from "../../../docs/v2/CLI.md?raw";
import dataAndPrivacySource from "../../../docs/v2/DATA_AND_PRIVACY.md?raw";
import migrationSource from "../../../docs/v2/MIGRATION.md?raw";
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
  title: string;
}

export const referenceSections: ReferenceSection[] = [
  { id: "start", label: "Start" },
  { id: "guides", label: "Use ResearchPocket" },
  { id: "reference", label: "Understand your data" },
  { id: "release", label: "Release" },
];

export const referenceDocuments: ReferenceDocument[] = [
  {
    description: "Install ResearchPocket, save a link, add context, and find it again.",
    id: "overview",
    section: "start",
    source: overviewSource,
    sourcePath: "README.md",
    title: "Getting started",
  },
  {
    description: "Commands for capture, enrichment, search, TUI use, and synchronization.",
    id: "cli",
    section: "guides",
    source: cliSource,
    sourcePath: "docs/v2/CLI.md",
    title: "CLI guide",
  },
  {
    description: "Import an existing V1 library without changing the source database.",
    id: "migration",
    section: "guides",
    source: migrationSource,
    sourcePath: "docs/v2/MIGRATION.md",
    title: "Move from V1",
  },
  {
    description: "Use the private browser app, work offline, and understand synchronization.",
    id: "hosted-owner",
    section: "guides",
    source: webSource,
    sourcePath: "docs/v2/WEB.md",
    title: "Browser app",
  },
  {
    description: "Where the library lives, how sync converges, and how credentials stay private.",
    id: "data-and-privacy",
    section: "reference",
    source: dataAndPrivacySource,
    sourcePath: "docs/v2/DATA_AND_PRIVACY.md",
    title: "Data, sync, and privacy",
  },
  {
    description: "What changed, how to upgrade, and where to download verified builds.",
    id: "release",
    section: "release",
    source: releaseSource,
    sourcePath: "docs/releases/v2.0.1.md",
    title: "ResearchPocket 2.0.1",
  },
];

export const referenceDocumentById = new Map(
  referenceDocuments.map((document) => [document.id, document]),
);

export const referenceDocumentBySourcePath = new Map(
  referenceDocuments.map((document) => [document.sourcePath, document]),
);
