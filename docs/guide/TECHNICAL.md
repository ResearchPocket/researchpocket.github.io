# Technical reference

These documents describe ResearchPocket's implementation, invariants, and target
architecture. Start with the [user documentation](INDEX.md) for current workflows.
Some contracts and ADRs describe planned capabilities or the state when a
decision was made; the [2.3.0 release notes](../releases/v2.3.0.md) establish the
current release behavior.

## Interface and storage contracts

- [CLI and TUI](../v2/CLI.md): commands, flags, shortcuts, and machine output.
- [Data, sync, and privacy](../v2/DATA_AND_PRIVACY.md): local storage, credentials,
  remote history, backups, and recovery.
- [Browser architecture](../v2/WEB.md): static shell, persistence, CSP, and offline boundaries.
- [Synchronization protocol](../v2/SYNC_PROTOCOL.md): wire formats, immutable paths,
  checkpoints, compatibility, and retries.
- [Threat model](../v2/THREAT_MODEL.md): trust boundaries and residual risks.
- [Design system](../v2/DESIGN_SYSTEM.md): visual tokens and interface rules.

## Product and contributor guidance

- [Product contract](../v2/PRODUCT.md): principles, scope, and target workflows.
- [Roadmap](../v2/ROADMAP.md): delivery phases and project conventions, including unshipped work.
- [Contributing](../../CONTRIBUTING.md): development and review expectations.
- [Engineering contract](../../AGENTS.md): repository-wide implementation invariants.

## Architecture decisions

| ADR | Decision |
| --- | --- |
| [0001](../v2/ADR_0001_NATIVE_BROWSER_CAPTURE.md) | Native browser capture |
| [0002](../v2/ADR_0002_LINK_ENRICHMENT.md) | Retryable link enrichment |
| [0003](../v2/ADR_0003_OPERATION_PACKS.md) | Immutable operation packs |
| [0004](../v2/ADR_0004_BOUNDED_FIRECRAWL_MARKDOWN.md) | Bounded captured Markdown |
| [0005](../v2/ADR_0005_COMPENSATING_UNDO.md) | Compensating undo |
| [0006](../v2/ADR_0006_STAGED_V2_PARITY.md) | Staged V2 release boundary |
| [0007](../v2/ADR_0007_CARGO_WORKSPACE_PUBLICATION.md) | Cargo workspace publication |
| [0008](../v2/ADR_0008_EXCERPT_AS_MERGED_TEXT.md) | Excerpts as merged text |
| [0009](../v2/ADR_0009_OPT_IN_MARKDOWN_IMAGES.md) | Opt-in Markdown images |
| [0010](../v2/ADR_0010_BOUNDED_ITEM_SCOPED_SYNC.md) | Bounded item-scoped synchronization (migration remains deferred) |
| [0011](../v2/ADR_0011_ZEN_DOCUMENTS.md) | Bounded Zen documents and item mentions |
| [0012](../v2/ADR_0012_DERIVED_LIBRARY_GRAPH.md) | Derived library graph |
| [0013](../v2/ADR_0013_REMEMBER_BROWSER_TOKEN.md) | Explicit browser-token persistence |
| [0014](../v2/ADR_0014_ZEN_LINK_COMPLETION.md) | Current browser update: Zen link completion, document references, and derived backlinks |

Zen has shipped in its own aggregate namespace; saves still use protocol v1.
The item-aggregate migration described by ADR 0010 has not shipped. An ADR's
accepted design is not evidence that every implementation step is complete.
