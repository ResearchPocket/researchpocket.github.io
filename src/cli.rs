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

    /// Save a URL immediately without network access
    Add(AddArgs),

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

#[derive(Clone, Copy, Debug, Default, ValueEnum)]
#[value(rename_all = "lower")]
pub enum OutputFormat {
    #[default]
    Human,
    Json,
    Ndjson,
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
