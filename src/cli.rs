use std::path::PathBuf;

use clap::{
    Args, Parser, Subcommand, ValueEnum, crate_authors, crate_description, crate_version,
};

#[derive(Parser)]
#[command(
    author = crate_authors!(),
    version = crate_version!(),
    about = crate_description!(),
    long_about = None,
    arg_required_else_help = true
)]
pub struct CliArgs {
    /// V2 library directory
    #[arg(
        long,
        env = "RESEARCHPOCKET_DATA_DIR",
        value_name = "DIR",
        global = true
    )]
    pub data_dir: Option<PathBuf>,

    /// Output format
    #[arg(
        long,
        value_enum,
        default_value_t = OutputFormat::Human,
        global = true
    )]
    pub format: OutputFormat,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Initialize a V2 library in the platform data directory
    Init,

    /// Save a URL locally, with optional post-save link enrichment
    Add(AddArgs),

    /// Configure and run optional link enrichment
    Enrich {
        #[command(subcommand)]
        command: EnrichCommands,
    },

    /// Edit one saved item by UUID
    Edit(EditArgs),

    /// Delete one saved item without erasing its history
    Delete(ItemIdArgs),

    /// Restore one deleted item
    Restore(ItemIdArgs),

    /// Import data into the V2 library
    Import {
        #[command(subcommand)]
        command: ImportCommands,
    },

    /// List saves in the V2 library
    List(ListArgs),

    /// Search URLs, authored fields, private notes, and tags
    Search(SearchArgs),

    /// Manage the local library in a keyboard-first terminal interface
    Tui,

    /// Save Firefox pages through an installed per-user protocol handler
    Capture {
        #[command(subcommand)]
        command: CaptureCommands,
    },

    /// Connect and synchronize through a private GitHub repository
    Sync {
        #[command(subcommand)]
        command: SyncCommands,
    },

    /// Show local library, import, outbox, and sync state
    Status,
}

#[derive(Args)]
pub struct AddArgs {
    /// Absolute HTTP(S) URL to save
    pub url: String,

    /// Optional title; an explicit empty string remains empty
    #[arg(long)]
    pub title: Option<String>,

    /// Optional excerpt; an explicit empty string remains empty
    #[arg(long)]
    pub excerpt: Option<String>,

    /// Optional language; an explicit empty string remains empty
    #[arg(long)]
    pub language: Option<String>,

    /// Mark the new save as a favorite
    #[arg(long)]
    pub favorite: bool,

    /// Private note text
    #[arg(long)]
    pub note: Option<String>,

    /// Exact tag text; repeat or comma-separate
    #[arg(short, long, value_delimiter = ',', num_args = 1..)]
    pub tag: Vec<String>,

    /// Original saved time as Unix seconds; defaults to now
    #[arg(long, value_name = "UNIX_SECONDS")]
    pub saved_at: Option<i64>,

    /// Save first, then fill missing page data with this provider
    #[arg(long, value_enum, value_name = "PROVIDER")]
    pub enrich: Option<EnrichmentProviderArg>,
}

#[derive(Subcommand)]
pub enum EnrichCommands {
    /// Choose the default provider and optional browser-capture policy
    Configure(EnrichConfigureArgs),

    /// Inspect local enrichment configuration without revealing credentials
    Status,

    /// Disable automatic enrichment and remove the stored Firecrawl credential
    Disable,

    /// Enrich one save, or process the durable retry queue when no ID is supplied
    Run(EnrichRunArgs),
}

#[derive(Args)]
pub struct EnrichConfigureArgs {
    /// Provider used by queued and automatic enrichment
    #[arg(value_enum)]
    pub provider: EnrichmentProviderArg,

    /// Automatically enrich browser captures after their durable local save
    #[arg(long)]
    pub on_capture: bool,

    /// Read a Firecrawl API key from standard input without echoing or persisting it in SQLite
    #[arg(long)]
    pub api_key_stdin: bool,

    /// Firecrawl API origin for an explicitly configured self-hosted deployment
    #[arg(long, value_name = "URL")]
    pub api_url: Option<String>,
}

#[derive(Args)]
pub struct EnrichRunArgs {
    /// Saved item UUID; omit it to process due retry jobs
    pub item_id: Option<String>,

    /// Provider for a newly queued item; defaults to local configuration
    #[arg(long, value_enum, value_name = "PROVIDER")]
    pub provider: Option<EnrichmentProviderArg>,

    /// Explicitly replace the current excerpt after re-parsing the saved URL
    #[arg(long, requires = "item_id")]
    pub replace_excerpt: bool,

    /// Maximum due jobs to process when no item ID is supplied
    #[arg(long, default_value_t = 25, value_parser = parse_enrichment_limit)]
    pub limit: usize,
}

#[derive(Args)]
pub struct EditArgs {
    /// UUID of the saved item
    pub item_id: String,

    /// Replace the URL
    #[arg(long)]
    pub url: Option<String>,

    /// Set the title; an explicit empty string remains empty
    #[arg(long, conflicts_with = "clear_title")]
    pub title: Option<String>,

    /// Set the title to absent
    #[arg(long)]
    pub clear_title: bool,

    /// Set the excerpt; an explicit empty string remains empty
    #[arg(long, conflicts_with = "clear_excerpt")]
    pub excerpt: Option<String>,

    /// Set the excerpt to absent
    #[arg(long)]
    pub clear_excerpt: bool,

    /// Set the language; an explicit empty string remains empty
    #[arg(long, conflicts_with = "clear_language")]
    pub language: Option<String>,

    /// Set the language to absent
    #[arg(long)]
    pub clear_language: bool,

    /// Set favorite state explicitly
    #[arg(long, value_name = "BOOL")]
    pub favorite: Option<bool>,

    /// Replace the private note; pass an empty string to clear it
    #[arg(long)]
    pub note: Option<String>,

    /// Replace the saved time using Unix seconds
    #[arg(long, value_name = "UNIX_SECONDS")]
    pub saved_at: Option<i64>,

    /// Add exact tag text; repeat or comma-separate
    #[arg(long, value_delimiter = ',', num_args = 1..)]
    pub add_tag: Vec<String>,

    /// Remove exact tag text; repeat or comma-separate
    #[arg(long, value_delimiter = ',', num_args = 1..)]
    pub remove_tag: Vec<String>,
}

#[derive(Args)]
pub struct ItemIdArgs {
    /// UUID of the saved item
    pub item_id: String,
}

#[derive(Subcommand)]
pub enum ImportCommands {
    /// Import a V1 ResearchPocket SQLite library without modifying it
    V1(ImportV1Args),
}

#[derive(Args)]
pub struct ImportV1Args {
    /// Existing V1 ResearchPocket SQLite database
    #[arg(value_name = "SOURCE_DB")]
    pub source: PathBuf,
}

#[derive(Args)]
pub struct ListArgs {
    /// Require every supplied tag; repeat or comma-separate
    #[arg(short, long, value_delimiter = ',', num_args = 1..)]
    pub tags: Vec<String>,

    /// Show favorites only
    #[arg(short = 'f', long)]
    pub favorite_only: bool,

    /// Include deleted items
    #[arg(long)]
    pub include_deleted: bool,

    /// Maximum number of results (defaults to 50)
    #[arg(
        short,
        long,
        value_parser = parse_limit,
        conflicts_with = "all"
    )]
    pub limit: Option<usize>,

    /// Return every matching item
    #[arg(long)]
    pub all: bool,

    /// Skip this many matching items
    #[arg(long, default_value_t = 0)]
    pub offset: usize,
}

#[derive(Args)]
pub struct SearchArgs {
    /// SQLite FTS5 query
    pub query: String,

    #[command(flatten)]
    pub filters: ListArgs,
}

#[derive(Subcommand)]
pub enum CaptureCommands {
    /// Install or update the per-user researchpocket:// handler
    Install,

    /// Inspect the installed per-user handler
    Status,

    /// Remove the per-user researchpocket:// handler
    Uninstall,

    /// Accept one versioned capture URI from the operating system
    #[command(hide = true)]
    Handle(CaptureHandleArgs),
}

#[derive(Args)]
pub struct CaptureHandleArgs {
    /// Complete researchpocket://capture URI
    #[arg(value_name = "CAPTURE_URI")]
    pub uri: String,

    /// Send a generic best-effort desktop notification
    #[arg(long, hide = true)]
    pub notify: bool,
}

#[derive(Subcommand)]
pub enum SyncCommands {
    /// Connect this library to an existing private GitHub repository and sync now
    Connect(SyncConnectArgs),

    /// Pull, apply, and upload immutable updates
    Run(SyncRunArgs),
}

#[derive(Args)]
pub struct SyncConnectArgs {
    /// Private GitHub repository written as OWNER/NAME
    #[arg(value_name = "OWNER/NAME")]
    pub repository: String,

    /// Repository branch; defaults to the repository's default branch
    #[arg(long)]
    pub branch: Option<String>,
}

#[derive(Args)]
pub struct SyncRunArgs {
    /// Repeat in the foreground at this interval; use NDJSON for machine output
    #[arg(long, value_name = "SECONDS", value_parser = parse_sync_interval)]
    pub every: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, ValueEnum)]
#[value(rename_all = "lower")]
pub enum OutputFormat {
    #[default]
    Human,
    Json,
    Ndjson,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
#[value(rename_all = "lower")]
pub enum EnrichmentProviderArg {
    /// Fetch public HTML directly from this device
    Direct,
    /// Send the URL to Firecrawl and retain bounded Markdown in the excerpt
    Firecrawl,
}

fn parse_limit(value: &str) -> Result<usize, String> {
    let limit = value
        .parse::<usize>()
        .map_err(|_| "limit must be an integer".to_owned())?;
    if !(1..=10_000).contains(&limit) {
        return Err("limit must be between 1 and 10000".to_owned());
    }
    Ok(limit)
}

fn parse_sync_interval(value: &str) -> Result<u64, String> {
    let seconds = value
        .parse::<u64>()
        .map_err(|_| "sync interval must be an integer".to_owned())?;
    if !(15..=86_400).contains(&seconds) {
        return Err("sync interval must be between 15 and 86400 seconds".to_owned());
    }
    Ok(seconds)
}

fn parse_enrichment_limit(value: &str) -> Result<usize, String> {
    let limit = value
        .parse::<usize>()
        .map_err(|_| "limit must be an integer".to_owned())?;
    if !(1..=100).contains(&limit) {
        return Err("limit must be between 1 and 100".to_owned());
    }
    Ok(limit)
}
