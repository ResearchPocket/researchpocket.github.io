use std::error::Error;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use directories::ProjectDirs;
use research_store::{
    CreateItemRequest, EditItemRequest, ListQuery, OptionalTextUpdate, SearchQuery, V2Store,
};
use serde::Serialize;
use serde_json::{Value, json};

use crate::cli::{CliArgs, Commands, ImportCommands, OutputFormat, SyncCommands};
use crate::sync;

type CliResult<T> = Result<T, Box<dyn Error>>;

const OUTPUT_SCHEMA_VERSION: u8 = 1;
const DATABASE_FILE: &str = "library.sqlite3";

pub async fn handle(args: &CliArgs) -> CliResult<()> {
    let data_dir = resolve_data_dir(args.data_dir.as_deref())?;

    match &args.command {
        Commands::Init => handle_init(&data_dir, args.format).await,
        Commands::Add(add) => {
            let store = V2Store::open(&data_dir).await?;
            let item = store
                .create_item(CreateItemRequest {
                    url: add.url.clone(),
                    title: add.title.clone(),
                    excerpt: add.excerpt.clone(),
                    favorite: add.favorite,
                    language: add.language.clone(),
                    saved_at: add.saved_at,
                    note: add.note.clone().unwrap_or_default(),
                    tags: add.tag.clone(),
                })
                .await?;
            let output = command_output("add", item)?;
            write_single(args.format, &output, human_add)
        }
        Commands::Edit(edit) => {
            let store = V2Store::open(&data_dir).await?;
            let item = store
                .edit_item(EditItemRequest {
                    item_id: edit.item_id.clone(),
                    url: edit.url.clone(),
                    title: optional_text_update(&edit.title, edit.clear_title),
                    excerpt: optional_text_update(&edit.excerpt, edit.clear_excerpt),
                    favorite: edit.favorite,
                    language: optional_text_update(&edit.language, edit.clear_language),
                    saved_at: edit.saved_at,
                    note: edit.note.clone(),
                    add_tags: edit.add_tag.clone(),
                    remove_tags: edit.remove_tag.clone(),
                })
                .await?;
            let output = command_output("edit", item)?;
            write_single(args.format, &output, human_edit)
        }
        Commands::Delete(item) => {
            let store = V2Store::open(&data_dir).await?;
            let item = store.delete_item(&item.item_id).await?;
            let output = command_output("delete", item)?;
            write_single(args.format, &output, human_delete)
        }
        Commands::Restore(item) => {
            let store = V2Store::open(&data_dir).await?;
            let item = store.restore_item(&item.item_id).await?;
            let output = command_output("restore", item)?;
            write_single(args.format, &output, human_restore)
        }
        Commands::Import {
            command: ImportCommands::V1(import),
        } => {
            let store = V2Store::open(&data_dir).await?;
            let result = store.import_v1(&import.source).await?;
            let output = command_output("import_v1", result)?;
            report_rejections(&output);
            write_single(args.format, &output, human_import)
        }
        Commands::List(list) => {
            let store = V2Store::open(&data_dir).await?;
            let result = store
                .list(ListQuery {
                    tags: list.tags.clone(),
                    favorite_only: list.favorite_only,
                    include_deleted: list.include_deleted,
                    limit: if list.all {
                        None
                    } else {
                        Some(list.limit.unwrap_or(50))
                    },
                    offset: list.offset,
                })
                .await?;
            let output = command_output("list", result)?;
            write_list(args.format, &output)
        }
        Commands::Search(search) => {
            let store = V2Store::open(&data_dir).await?;
            let filters = &search.filters;
            let result = store
                .search(SearchQuery {
                    text: search.query.clone(),
                    tags: filters.tags.clone(),
                    favorite_only: filters.favorite_only,
                    include_deleted: filters.include_deleted,
                    limit: if filters.all {
                        None
                    } else {
                        Some(filters.limit.unwrap_or(50))
                    },
                    offset: filters.offset,
                })
                .await?;
            let output = command_output("search", result)?;
            write_search(args.format, &output)
        }
        Commands::Sync { command } => handle_sync(&data_dir, args.format, command).await,
        Commands::Status => handle_status(&data_dir, args.format).await,
    }
}

async fn handle_sync(
    data_dir: &Path,
    format: OutputFormat,
    command: &SyncCommands,
) -> CliResult<()> {
    let store = V2Store::open(data_dir).await?;
    match command {
        SyncCommands::Connect(connect) => {
            let result =
                sync::connect(&store, &connect.repository, connect.branch.as_deref()).await?;
            let output = command_output("sync_connect", result)?;
            write_single(format, &output, human_sync_connect)
        }
        SyncCommands::Run(run) => {
            if run.every.is_some() && format == OutputFormat::Json {
                return Err(io::Error::other(
                    "--every produces a stream; use --format ndjson or human output",
                )
                .into());
            }
            let Some(seconds) = run.every else {
                let result = sync::run_once(&store).await?;
                let output = command_output("sync_run", result)?;
                return write_single(format, &output, human_sync_run);
            };
            loop {
                let retry_after = match sync::run_once(&store).await {
                    Ok(result) => {
                        let output = command_output("sync_run", result)?;
                        write_single(format, &output, human_sync_run)?;
                        None
                    }
                    Err(error) if error.is_retryable() => {
                        write_sync_retry(format, &error)?;
                        error.retry_after()
                    }
                    Err(error) => return Err(error.into()),
                };
                let delay = retry_after
                    .map(|retry_after| retry_after.max(Duration::from_secs(seconds)))
                    .unwrap_or_else(|| Duration::from_secs(seconds));
                tokio::select! {
                    result = tokio::signal::ctrl_c() => {
                        result?;
                        return Ok(());
                    }
                    () = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}

fn write_sync_retry(format: OutputFormat, error: &sync::SyncError) -> CliResult<()> {
    match format {
        OutputFormat::Human => {
            eprintln!("Synchronization will retry: {error}");
        }
        OutputFormat::Ndjson => {
            write_json(
                &json!({
                    "schema_version": OUTPUT_SCHEMA_VERSION,
                    "command": "sync_run",
                    "type": "sync_error",
                    "error_kind": error.kind(),
                    "retryable": true
                }),
                false,
            )?;
        }
        OutputFormat::Json => {
            return Err(io::Error::other(
                "periodic synchronization cannot emit one JSON document",
            )
            .into());
        }
    }
    Ok(())
}

fn optional_text_update(value: &Option<String>, clear: bool) -> Option<OptionalTextUpdate> {
    if clear {
        Some(OptionalTextUpdate::Clear)
    } else {
        value.clone().map(OptionalTextUpdate::Set)
    }
}

async fn handle_init(data_dir: &Path, format: OutputFormat) -> CliResult<()> {
    let created = !data_dir.join(DATABASE_FILE).is_file();
    let store = V2Store::init(data_dir).await?;
    let status = store.status().await?;
    let mut output = command_output("init", status)?;
    let object = output
        .as_object_mut()
        .ok_or_else(|| io::Error::other("V2 status did not serialize as an object"))?;
    object.insert("created".into(), Value::Bool(created));
    object.insert(
        "data_dir".into(),
        Value::String(data_dir.display().to_string()),
    );
    object.insert(
        "database_path".into(),
        Value::String(store.database_path().display().to_string()),
    );
    write_single(format, &output, human_init)
}

async fn handle_status(data_dir: &Path, format: OutputFormat) -> CliResult<()> {
    if !data_dir.join(DATABASE_FILE).is_file() {
        let output = json!({
            "schema_version": OUTPUT_SCHEMA_VERSION,
            "command": "status",
            "initialized": false,
            "data_dir": data_dir.display().to_string(),
            "database_path": data_dir.join(DATABASE_FILE).display().to_string(),
            "sync_state": "not_configured"
        });
        return write_single(format, &output, human_status);
    }

    let store = V2Store::open(data_dir).await?;
    let status = store.status().await?;
    let mut output = command_output("status", status)?;
    let object = output
        .as_object_mut()
        .ok_or_else(|| io::Error::other("V2 status did not serialize as an object"))?;
    object.insert("initialized".into(), Value::Bool(true));
    object.insert(
        "data_dir".into(),
        Value::String(data_dir.display().to_string()),
    );
    object.insert(
        "database_path".into(),
        Value::String(store.database_path().display().to_string()),
    );
    write_single(format, &output, human_status)
}

fn resolve_data_dir(explicit: Option<&Path>) -> CliResult<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path.to_path_buf());
    }

    let project = ProjectDirs::from("io.github", "ResearchPocket", "ResearchPocket")
        .ok_or_else(|| io::Error::other("this platform has no application data directory"))?;
    Ok(project.data_local_dir().to_path_buf())
}

fn command_output(command: &str, value: impl Serialize) -> CliResult<Value> {
    let value = serde_json::to_value(value)?;
    let mut object = match value {
        Value::Object(object) => object,
        _ => {
            return Err(io::Error::other(format!(
                "V2 {command} result did not serialize as an object"
            ))
            .into());
        }
    };
    object.insert("schema_version".into(), Value::from(OUTPUT_SCHEMA_VERSION));
    object.insert("command".into(), Value::String(command.to_owned()));
    Ok(Value::Object(object))
}

fn write_single(format: OutputFormat, value: &Value, human: fn(&Value)) -> CliResult<()> {
    match format {
        OutputFormat::Human => human(value),
        OutputFormat::Json => write_json(value, true)?,
        OutputFormat::Ndjson => write_json(value, false)?,
    }
    Ok(())
}

fn write_list(format: OutputFormat, value: &Value) -> CliResult<()> {
    write_items(format, value, human_list)
}

fn write_search(format: OutputFormat, value: &Value) -> CliResult<()> {
    write_items(format, value, human_search)
}

fn write_items(format: OutputFormat, value: &Value, human: fn(&Value)) -> CliResult<()> {
    match format {
        OutputFormat::Human => human(value),
        OutputFormat::Json => write_json(value, true)?,
        OutputFormat::Ndjson => {
            let object = value
                .as_object()
                .ok_or_else(|| io::Error::other("V2 list output is not an object"))?;
            let items = object
                .get("items")
                .and_then(Value::as_array)
                .ok_or_else(|| io::Error::other("V2 list output has no items array"))?;
            let page_type = if value.get("query").is_some() {
                "search_page"
            } else {
                "list_page"
            };
            let mut page = json!({
                "schema_version": OUTPUT_SCHEMA_VERSION,
                "type": page_type,
                "total": value.pointer("/page/total").cloned().unwrap_or(Value::from(items.len())),
                "offset": value.pointer("/page/offset").cloned().unwrap_or(Value::from(0)),
                "returned": value.pointer("/page/returned").cloned().unwrap_or(Value::from(items.len()))
            });
            if let Some(query) = value.get("query") {
                page["query"] = query.clone();
            }
            write_json(&page, false)?;
            for item in items {
                write_json(
                    &json!({
                        "schema_version": OUTPUT_SCHEMA_VERSION,
                        "type": "item",
                        "item": item
                    }),
                    false,
                )?;
            }
        }
    }
    Ok(())
}

fn write_json(value: &Value, pretty: bool) -> CliResult<()> {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    if pretty {
        serde_json::to_writer_pretty(&mut output, value)?;
    } else {
        serde_json::to_writer(&mut output, value)?;
    }
    writeln!(output)?;
    Ok(())
}

fn human_init(value: &Value) {
    let created = value
        .get("created")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    println!(
        "{} ResearchPocket V2 library",
        if created {
            "Initialized"
        } else {
            "Using existing"
        }
    );
    print_string(value, "library_id", "Library");
    print_string(value, "data_dir", "Data directory");
    print_string(value, "database_path", "Database");
}

fn human_add(value: &Value) {
    human_mutation("Saved", value);
}

fn human_edit(value: &Value) {
    human_mutation("Updated", value);
}

fn human_delete(value: &Value) {
    human_mutation("Deleted", value);
}

fn human_restore(value: &Value) {
    human_mutation("Restored", value);
}

fn human_mutation(action: &str, value: &Value) {
    println!("{action} item");
    print_string(value, "id", "ID");
    print_string(value, "url", "URL");
    print_string(value, "title", "Title");
    print_string(value, "saved_at", "Saved");
    print_string(value, "state", "State");
}

fn human_import(value: &Value) {
    let diagnostics = value
        .get("rejection_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    println!(
        "{}",
        if diagnostics == 0 {
            "V1 import complete"
        } else {
            "V1 import complete with migration diagnostics"
        }
    );
    print_string(value, "source_sha256", "Source SHA-256");
    print_string(value, "source_bundle_sha256", "Source bundle SHA-256");
    print_number(value, "scanned", "Scanned");
    print_number(value, "imported", "Imported");
    print_number(value, "skipped", "Skipped");
    print_number(value, "rejection_count", "Diagnostics");
    print_number(value, "tags_imported", "Distinct tags imported");
    print_bool(value, "source_unchanged", "Source unchanged");
}

fn human_sync_connect(value: &Value) {
    println!("Connected private synchronization repository");
    print_remote(value.get("remote"));
    print_bool(value, "adopted_remote_library", "Adopted remote library");
    if let Some(cycle) = value.get("cycle") {
        print_sync_counts(cycle);
    }
}

fn human_sync_run(value: &Value) {
    println!("Synchronization complete");
    print_remote(value.get("remote"));
    print_sync_counts(value);
}

fn print_remote(remote: Option<&Value>) {
    let Some(remote) = remote else {
        return;
    };
    let owner = remote.get("owner").and_then(Value::as_str);
    let repository = remote.get("repository").and_then(Value::as_str);
    if let (Some(owner), Some(repository)) = (owner, repository) {
        println!("Repository: {owner}/{repository}");
    }
    print_string(remote, "branch", "Branch");
}

fn print_sync_counts(value: &Value) {
    print_number(value, "remote_batches_seen", "Remote batches observed");
    print_number(value, "downloaded", "Downloaded");
    print_number(value, "applied", "Applied");
    print_number(value, "already_applied", "Already applied");
    print_number(value, "acknowledged", "Acknowledged");
    print_number(value, "uploaded", "Uploaded");
    print_number(value, "pending", "Pending");
}

fn human_status(value: &Value) {
    let initialized = value
        .get("initialized")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    println!(
        "ResearchPocket V2: {}",
        if initialized {
            "initialized"
        } else {
            "not initialized"
        }
    );
    print_string(value, "library_id", "Library");
    print_string(value, "device_id", "Device");
    print_string(value, "data_dir", "Data directory");
    print_string(value, "database_path", "Database");
    print_number(value, "active_items", "Active saves");
    print_number(value, "deleted_items", "Deleted saves");
    print_number(value, "pending_updates", "Pending updates");
    print_number(value, "deferred_updates", "Deferred remote updates");
    let sync_state = value
        .get("sync")
        .and_then(|sync| sync.get("state"))
        .and_then(Value::as_str)
        .or_else(|| value.get("sync_state").and_then(Value::as_str));
    if let Some(state) = sync_state {
        println!("Sync: {state}");
    }
    if let Some(remote) = value.get("sync_remote") {
        print_remote(Some(remote));
        print_string(remote, "last_success_at", "Last successful sync");
        print_string(remote, "last_error_kind", "Last sync error");
    }
}

fn human_list(value: &Value) {
    let Some(items) = value.get("items").and_then(Value::as_array) else {
        println!("No saves found");
        return;
    };
    let total = value
        .pointer("/page/total")
        .and_then(Value::as_u64)
        .unwrap_or(items.len() as u64);
    println!("Showing {} of {total} saves", items.len());

    for item in items {
        println!();
        let favorite = item
            .get("favorite")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let title = item
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled");
        println!("{}{}", if favorite { "★ " } else { "" }, title);
        print_indented_string(item, "url", "URL");
        print_indented_string(item, "id", "ID");
        print_indented_string(item, "saved_at", "Saved");
        if let Some(tags) = item.get("tags").and_then(Value::as_array) {
            let tags = tags.iter().filter_map(Value::as_str).collect::<Vec<_>>();
            if !tags.is_empty() {
                println!("  tags: {}", tags.join(", "));
            }
        }
        if item.get("state").and_then(Value::as_str) == Some("deleted") {
            println!("  state: deleted");
        }
    }
}

fn human_search(value: &Value) {
    if let Some(query) = value.get("query").and_then(Value::as_str) {
        println!("Search: {query}");
    }
    human_list(value);
}

fn report_rejections(value: &Value) {
    let Some(rejections) = value.get("rejections").and_then(Value::as_array) else {
        return;
    };
    for rejection in rejections {
        let id = rejection
            .get("legacy_id")
            .and_then(Value::as_i64)
            .map(|id| id.to_string())
            .unwrap_or_else(|| "unknown row".to_owned());
        let reason = rejection
            .get("reason")
            .or_else(|| rejection.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("invalid record");
        eprintln!("V1 import diagnostic for row {id}: {reason}");
    }
}

fn print_string(value: &Value, field: &str, label: &str) {
    if let Some(text) = value.get(field).and_then(Value::as_str) {
        println!("{label}: {text}");
    }
}

fn print_number(value: &Value, field: &str, label: &str) {
    if let Some(number) = value.get(field).and_then(Value::as_u64) {
        println!("{label}: {number}");
    }
}

fn print_bool(value: &Value, field: &str, label: &str) {
    if let Some(flag) = value.get(field).and_then(Value::as_bool) {
        println!("{label}: {}", if flag { "yes" } else { "no" });
    }
}

fn print_indented_string(value: &Value, field: &str, label: &str) {
    if let Some(text) = value.get(field).and_then(Value::as_str) {
        println!("  {label}: {text}");
    }
}
