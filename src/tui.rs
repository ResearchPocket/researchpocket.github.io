use std::collections::{BTreeSet, VecDeque};
use std::error::Error;
use std::io::{self, IsTerminal, Stdout};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crossterm::cursor::{Hide, Show};
use crossterm::event::{
    self, DisableBracketedPaste, EnableBracketedPaste, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers,
};
use crossterm::execute;
use crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Alignment, Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::{Frame, Terminal};
use research_store::{
    CreateItemRequest, EditItemRequest, EnrichmentStatus as StoreEnrichmentStatus, ListQuery,
    OptionalTextUpdate, SearchQuery, StoreStatus, StoredItem, V2Store,
};
use serde_json::Value;
use tokio::task::JoinHandle;
use unicode_width::UnicodeWidthStr;

use crate::{sync, v2};

type TuiResult<T> = Result<T, Box<dyn Error>>;

const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const ACTION_LATCH_IDLE: Duration = Duration::from_secs(2);
const MIN_COMFORTABLE_WIDTH: u16 = 72;
const MIN_COMFORTABLE_HEIGHT: u16 = 20;

pub async fn run(store: &V2Store, data_dir: &Path) -> TuiResult<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(io::Error::other("the TUI requires an interactive terminal").into());
    }

    let mut terminal = TerminalSession::new()?;
    let shutdown = install_signal_handlers()?;
    let mut app = App::load(store).await?;

    while !app.should_quit && !shutdown.load(Ordering::Relaxed) {
        if app.operation_finished() {
            app.finish_operation(store, data_dir).await;
        }
        terminal.terminal.draw(|frame| render(frame, &mut app))?;
        if !event::poll(EVENT_POLL_INTERVAL)? {
            app.clear_action_latch();
            continue;
        }
        match event::read()? {
            Event::Key(key) if key.kind == KeyEventKind::Press && app.accept_key_press(key) => {
                app.handle_key(store, data_dir, key).await;
            }
            Event::Key(key) if key.kind == KeyEventKind::Repeat => {
                app.note_key_repeat(key);
                app.handle_repeat_key(key);
            }
            Event::Key(key) if key.kind == KeyEventKind::Release => {
                app.release_key(key);
            }
            Event::Paste(text) => app.handle_paste(text),
            Event::Resize(_, _) => {}
            _ => {}
        }
    }

    Ok(())
}

fn install_signal_handlers() -> io::Result<Arc<AtomicBool>> {
    let shutdown = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    for signal in [
        signal_hook::consts::signal::SIGHUP,
        signal_hook::consts::signal::SIGINT,
        signal_hook::consts::signal::SIGTERM,
    ] {
        signal_hook::flag::register(signal, Arc::clone(&shutdown))?;
    }
    Ok(shutdown)
}

struct TerminalSession {
    terminal: Terminal<CrosstermBackend<Stdout>>,
}

impl TerminalSession {
    fn new() -> io::Result<Self> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        if let Err(error) = execute!(stdout, EnterAlternateScreen, EnableBracketedPaste, Hide) {
            let _ = execute!(stdout, Show, DisableBracketedPaste, LeaveAlternateScreen);
            let _ = disable_raw_mode();
            return Err(error);
        }
        match Terminal::new(CrosstermBackend::new(stdout)) {
            Ok(terminal) => Ok(Self { terminal }),
            Err(error) => {
                let mut stdout = io::stdout();
                let _ = execute!(stdout, Show, DisableBracketedPaste, LeaveAlternateScreen);
                let _ = disable_raw_mode();
                Err(error)
            }
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(
            self.terminal.backend_mut(),
            Show,
            DisableBracketedPaste,
            LeaveAlternateScreen
        );
        let _ = self.terminal.show_cursor();
    }
}

struct App {
    items: Vec<StoredItem>,
    selected: usize,
    list_state: ListState,
    query: String,
    favorite_only: bool,
    lifecycle: LifecycleFilter,
    status: StoreStatus,
    mode: Mode,
    notice: Option<Notice>,
    detail_scroll: u16,
    should_quit: bool,
    action_latch: Option<(ModeKind, KeyCode, KeyModifiers, Instant)>,
    operation: Option<BackgroundOperation>,
    queued_enrichment: VecDeque<(String, &'static str)>,
}

impl App {
    async fn load(store: &V2Store) -> TuiResult<Self> {
        let status = store.status().await?;
        let mut app = Self {
            items: Vec::new(),
            selected: 0,
            list_state: ListState::default(),
            query: String::new(),
            favorite_only: false,
            lifecycle: LifecycleFilter::Active,
            status,
            mode: Mode::Browse,
            notice: None,
            detail_scroll: 0,
            should_quit: false,
            action_latch: None,
            operation: None,
            queued_enrichment: VecDeque::new(),
        };
        app.refresh(store, None).await?;
        Ok(app)
    }

    async fn refresh(&mut self, store: &V2Store, preferred_id: Option<&str>) -> TuiResult<()> {
        let selected_id = preferred_id
            .map(str::to_owned)
            .or_else(|| self.selected_item().map(|item| item.id.clone()));
        let include_deleted = self.lifecycle != LifecycleFilter::Active;
        let mut items = if self.query.trim().is_empty() {
            store
                .list(ListQuery {
                    favorite_only: self.favorite_only,
                    include_deleted,
                    limit: None,
                    ..ListQuery::default()
                })
                .await?
                .items
        } else {
            store
                .search(SearchQuery {
                    text: self.query.clone(),
                    favorite_only: self.favorite_only,
                    include_deleted,
                    limit: None,
                    ..SearchQuery::default()
                })
                .await?
                .items
        };
        if self.lifecycle == LifecycleFilter::Deleted {
            items.retain(|item| item.state == "deleted");
        }
        let status = store.status().await?;

        let next_selected = selected_id
            .as_ref()
            .and_then(|id| items.iter().position(|item| item.id == *id))
            .unwrap_or_else(|| self.selected.min(items.len().saturating_sub(1)));
        let next_selected_id = items.get(next_selected).map(|item| item.id.as_str());
        if selected_id.as_deref() != next_selected_id {
            self.detail_scroll = 0;
        }
        self.items = items;
        self.selected = next_selected;
        self.sync_selection();
        self.status = status;
        Ok(())
    }

    async fn handle_key(&mut self, store: &V2Store, data_dir: &Path, key: KeyEvent) {
        if control_shortcut(key) && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        self.notice = None;

        match &mut self.mode {
            Mode::Browse => self.handle_browse_key(store, data_dir, key).await,
            Mode::Search(input) => {
                if key.code == KeyCode::Esc {
                    self.mode = Mode::Browse;
                    return;
                }
                if key.code == KeyCode::Enter && command_key(key) {
                    let previous_query = std::mem::replace(&mut self.query, input.value());
                    match self.refresh(store, None).await {
                        Ok(()) => self.mode = Mode::Browse,
                        Err(error) => {
                            self.query = previous_query;
                            self.notice_error(error);
                        }
                    }
                    return;
                }
                input.handle_key(key, false);
            }
            Mode::Form(form) => {
                if key.code == KeyCode::Esc {
                    self.mode = Mode::Browse;
                    return;
                }
                if control_shortcut(key) && key.code == KeyCode::Char('s') {
                    self.submit_form(store, data_dir).await;
                    return;
                }
                form.handle_key(key);
            }
            Mode::SyncSetup(form) => {
                if key.code == KeyCode::Esc {
                    self.mode = Mode::Browse;
                    return;
                }
                if control_shortcut(key) && key.code == KeyCode::Char('s') {
                    self.submit_sync_setup(data_dir);
                    return;
                }
                form.handle_key(key);
            }
            Mode::ConfirmDelete => match key.code {
                KeyCode::Enter | KeyCode::Char('y') if command_key(key) => {
                    self.delete_selected(store).await;
                }
                KeyCode::Char('n') if command_key(key) => self.mode = Mode::Browse,
                KeyCode::Esc => self.mode = Mode::Browse,
                _ => {}
            },
            Mode::Help => {
                if key.code == KeyCode::Esc
                    || command_key(key)
                        && matches!(key.code, KeyCode::Char('?') | KeyCode::Enter)
                {
                    self.mode = Mode::Browse;
                }
            }
        }
    }

    fn accept_key_press(&mut self, key: KeyEvent) -> bool {
        let mode = self.mode.kind();
        let signature = (key.code, key.modifiers);
        if let Some((latched_mode, code, modifiers, observed_at)) = &mut self.action_latch
            && (*latched_mode, *code, *modifiers) == (mode, signature.0, signature.1)
        {
            *observed_at = Instant::now();
            return false;
        }
        self.action_latch = self
            .is_one_shot_key(key)
            .then(|| (mode, signature.0, signature.1, Instant::now()));
        true
    }

    fn release_key(&mut self, key: KeyEvent) {
        if self
            .action_latch
            .as_ref()
            .is_some_and(|(_, code, modifiers, _)| {
                (*code, *modifiers) == (key.code, key.modifiers)
            })
        {
            self.action_latch = None;
        }
    }

    fn note_key_repeat(&mut self, key: KeyEvent) {
        if let Some((_, code, modifiers, observed_at)) = &mut self.action_latch
            && (*code, *modifiers) == (key.code, key.modifiers)
        {
            *observed_at = Instant::now();
        }
    }

    fn clear_action_latch(&mut self) {
        if self
            .action_latch
            .as_ref()
            .is_some_and(|(_, _, _, observed_at)| observed_at.elapsed() >= ACTION_LATCH_IDLE)
        {
            self.action_latch = None;
        }
    }

    fn is_one_shot_key(&self, key: KeyEvent) -> bool {
        if control_shortcut(key) && key.code == KeyCode::Char('c') {
            return true;
        }
        match &self.mode {
            Mode::Browse => {
                key.code == KeyCode::Esc && !self.query.is_empty()
                    || command_key(key)
                        && matches!(
                            key.code,
                            KeyCode::Char('?' | '/' | 'a' | 'e' | 'E' | 's' | ' ' | 'x' | 'r')
                                | KeyCode::Enter
                        )
            }
            Mode::Search(_) => {
                key.code == KeyCode::Esc || key.code == KeyCode::Enter && command_key(key)
            }
            Mode::Form(form) => {
                key.code == KeyCode::Esc
                    || control_shortcut(key) && key.code == KeyCode::Char('s')
                    || form.active >= form.fields.len()
                        && key.code == KeyCode::Char(' ')
                        && command_key(key)
            }
            Mode::SyncSetup(_) => {
                key.code == KeyCode::Esc
                    || control_shortcut(key) && key.code == KeyCode::Char('s')
            }
            Mode::ConfirmDelete => {
                key.code == KeyCode::Esc
                    || command_key(key)
                        && matches!(key.code, KeyCode::Enter | KeyCode::Char('y' | 'n'))
            }
            Mode::Help => {
                key.code == KeyCode::Esc
                    || command_key(key)
                        && matches!(key.code, KeyCode::Char('?') | KeyCode::Enter)
            }
        }
    }

    fn handle_repeat_key(&mut self, key: KeyEvent) {
        self.notice = None;
        match &mut self.mode {
            Mode::Browse => match key.code {
                KeyCode::Down | KeyCode::Char('j') if command_key(key) => self.select_next(1),
                KeyCode::Up | KeyCode::Char('k') if command_key(key) => self.select_previous(1),
                KeyCode::PageDown if command_key(key) => self.select_next(10),
                KeyCode::PageUp if command_key(key) => self.select_previous(10),
                KeyCode::Char('d') if control_shortcut(key) => {
                    self.detail_scroll = self.detail_scroll.saturating_add(5);
                }
                KeyCode::Char('u') if control_shortcut(key) => {
                    self.detail_scroll = self.detail_scroll.saturating_sub(5);
                }
                _ => {}
            },
            Mode::Search(_)
            | Mode::Form(_)
            | Mode::SyncSetup(_)
            | Mode::ConfirmDelete
            | Mode::Help => {}
        }
    }

    async fn handle_browse_key(&mut self, store: &V2Store, data_dir: &Path, key: KeyEvent) {
        if self.operation_blocks_mutations()
            && command_key(key)
            && matches!(
                key.code,
                KeyCode::Char('a' | 'e' | 'E' | ' ' | 'x' | 'r') | KeyCode::Enter
            )
        {
            self.notice = Some(Notice::info(
                "Wait for the initial sync connection to finish before changing this library",
            ));
            return;
        }
        match key.code {
            KeyCode::Char('q') if command_key(key) => self.should_quit = true,
            KeyCode::Char('?') if command_key(key) => self.mode = Mode::Help,
            KeyCode::Down | KeyCode::Char('j') if command_key(key) => self.select_next(1),
            KeyCode::Up | KeyCode::Char('k') if command_key(key) => self.select_previous(1),
            KeyCode::PageDown if command_key(key) => self.select_next(10),
            KeyCode::PageUp if command_key(key) => self.select_previous(10),
            KeyCode::Home | KeyCode::Char('g') if command_key(key) => self.select_first(),
            KeyCode::End | KeyCode::Char('G') if command_key(key) => self.select_last(),
            KeyCode::Char('/') if command_key(key) => {
                self.mode = Mode::Search(TextInput::new(self.query.clone()));
            }
            KeyCode::Esc if !self.query.is_empty() => {
                let previous_query = self.query.clone();
                self.query.clear();
                if !self.refresh_or_notice(store, None).await {
                    self.query = previous_query;
                }
            }
            KeyCode::Char('f') if command_key(key) => {
                self.favorite_only = !self.favorite_only;
                if !self.refresh_or_notice(store, None).await {
                    self.favorite_only = !self.favorite_only;
                }
            }
            KeyCode::Char('d') if control_shortcut(key) => {
                self.detail_scroll = self.detail_scroll.saturating_add(5);
            }
            KeyCode::Char('u') if control_shortcut(key) => {
                self.detail_scroll = self.detail_scroll.saturating_sub(5);
            }
            KeyCode::Char('d') if command_key(key) => {
                let previous = self.lifecycle;
                self.lifecycle = self.lifecycle.next();
                if !self.refresh_or_notice(store, None).await {
                    self.lifecycle = previous;
                }
            }
            KeyCode::Char('R') if command_key(key) => {
                let _ = self.refresh_or_notice(store, None).await;
            }
            KeyCode::Char('a') if command_key(key) => {
                self.mode = Mode::Form(Box::new(ItemForm::create()));
            }
            KeyCode::Char('e') | KeyCode::Enter if command_key(key) => {
                if let Some(item) = self.selected_item().cloned() {
                    self.mode = Mode::Form(Box::new(ItemForm::edit(item)));
                }
            }
            KeyCode::Char('E') if command_key(key) => {
                self.enrich_selected(data_dir);
            }
            KeyCode::Char('s') if command_key(key) => {
                if self.operation.is_some() {
                    self.notice =
                        Some(Notice::info("Another network operation is still running"));
                } else if self.status.sync_remote.is_some() {
                    self.synchronize(data_dir);
                } else {
                    self.mode = Mode::SyncSetup(SyncForm::new());
                }
            }
            KeyCode::Char(' ') if command_key(key) => self.toggle_favorite(store).await,
            KeyCode::Char('x') if command_key(key) => {
                if self
                    .selected_item()
                    .is_some_and(|item| item.state == "active")
                {
                    self.mode = Mode::ConfirmDelete;
                }
            }
            KeyCode::Char('r') if command_key(key) => self.restore_selected(store).await,
            _ => {}
        }
    }

    fn handle_paste(&mut self, text: String) {
        match &mut self.mode {
            Mode::Search(input) => input.insert_text(&single_line(&text)),
            Mode::Form(form) => form.insert_text(text),
            Mode::SyncSetup(form) => form.insert_text(text),
            _ => {}
        }
    }

    async fn submit_form(&mut self, store: &V2Store, data_dir: &Path) {
        let Mode::Form(form) = &self.mode else {
            return;
        };
        let submission = match form.submission() {
            Ok(submission) => submission,
            Err(error) => {
                self.notice_error(error);
                return;
            }
        };
        let result: TuiResult<(StoredItem, bool)> = match submission {
            FormSubmission::Create { request, enrich } => {
                if enrich {
                    let provider = match v2::configured_provider(data_dir) {
                        Ok(Some(provider)) => provider,
                        Ok(None) => {
                            self.notice_error(
                                "No enrichment provider is configured. Run `research enrich configure direct` or configure Firecrawl.",
                            );
                            return;
                        }
                        Err(error) => {
                            self.notice_error(error);
                            return;
                        }
                    };
                    store
                        .create_item_with_enrichment(request, provider)
                        .await
                        .map(|item| (item, true))
                        .map_err(Into::into)
                } else {
                    store
                        .create_item(request)
                        .await
                        .map(|item| (item, false))
                        .map_err(Into::into)
                }
            }
            FormSubmission::Edit(request) => store
                .edit_item(request)
                .await
                .map(|item| (item, false))
                .map_err(Into::into),
        };
        match result {
            Ok((item, enrich)) => {
                let item_id = item.id.clone();
                let action = if form.original.is_some() {
                    "Saved changes"
                } else {
                    "Captured save"
                };
                self.mode = Mode::Browse;
                self.notice = if enrich && self.operation.is_some() {
                    Some(Notice::info(
                        "Captured save; enrichment will run after the active network operation",
                    ))
                } else if enrich {
                    Some(Notice::info("Captured save; enriching metadata"))
                } else {
                    Some(Notice::info(action))
                };
                let _ = self.refresh_or_notice(store, Some(&item_id)).await;
                if enrich {
                    if self.operation.is_none() {
                        self.start_enrichment(data_dir, item_id, "Captured save");
                    } else {
                        self.queued_enrichment.push_back((item_id, "Captured save"));
                    }
                }
            }
            Err(error) => self.notice_error(error),
        }
    }

    fn enrich_selected(&mut self, data_dir: &Path) {
        if self.operation.is_some() {
            self.notice = Some(Notice::info("Another network operation is still running"));
            return;
        }
        let Some(item) = self.selected_item().cloned() else {
            return;
        };
        if item.state != "active" {
            self.notice = Some(Notice::info("Restore the save before enriching it"));
            return;
        }
        self.notice = Some(Notice::info("Enriching selected save"));
        self.start_enrichment(data_dir, item.id, "Enrichment");
    }

    fn synchronize(&mut self, data_dir: &Path) {
        let data_dir = data_dir.to_path_buf();
        self.notice = Some(Notice::info("Synchronizing with GitHub"));
        self.operation = Some(BackgroundOperation {
            label: "syncing",
            blocks_mutations: false,
            handle: tokio::spawn(async move {
                let completion = match V2Store::open(&data_dir).await {
                    Ok(store) => match sync::run_once(&store).await {
                        Ok(result) => Notice::info(format!(
                            "Sync complete: {} downloaded, {} uploaded, {} pending",
                            result.downloaded, result.uploaded, result.pending
                        )),
                        Err(error) => Notice::error(error.to_string()),
                    },
                    Err(error) => Notice::error(error.to_string()),
                };
                BackgroundCompletion {
                    notice: completion,
                    preferred_id: None,
                }
            }),
        });
    }

    fn submit_sync_setup(&mut self, data_dir: &Path) {
        let Mode::SyncSetup(form) = &self.mode else {
            return;
        };
        let (repository, branch) = match form.submission() {
            Ok(submission) => submission,
            Err(error) => {
                self.notice_error(error);
                return;
            }
        };
        let data_dir = data_dir.to_path_buf();
        self.mode = Mode::Browse;
        self.notice = Some(Notice::info("Connecting private GitHub sync"));
        self.operation = Some(BackgroundOperation {
            label: "connecting sync",
            blocks_mutations: true,
            handle: tokio::spawn(async move {
                let completion = match V2Store::open(&data_dir).await {
                    Ok(store) => {
                        match sync::connect(&store, &repository, branch.as_deref()).await {
                            Ok(result) => Notice::info(format!(
                                "Connected and synced {}/{}: {} downloaded, {} uploaded",
                                result.remote.owner,
                                result.remote.repository,
                                result.cycle.downloaded,
                                result.cycle.uploaded
                            )),
                            Err(error) => Notice::error(error.to_string()),
                        }
                    }
                    Err(error) => Notice::error(error.to_string()),
                };
                BackgroundCompletion {
                    notice: completion,
                    preferred_id: None,
                }
            }),
        });
    }

    fn start_enrichment(&mut self, data_dir: &Path, item_id: String, action: &'static str) {
        let data_dir = data_dir.to_path_buf();
        let preferred_id = item_id.clone();
        self.operation = Some(BackgroundOperation {
            label: "enriching",
            blocks_mutations: false,
            handle: tokio::spawn(async move {
                let notice = match V2Store::open(&data_dir).await {
                    Ok(store) => {
                        let result = if action == "Captured save" {
                            v2::attempt_queued_enrichment(&store, &data_dir, &item_id)
                                .await
                                .and_then(|outcome| {
                                    outcome.ok_or_else(|| {
                                        io::Error::other("the enrichment job disappeared")
                                            .into()
                                    })
                                })
                        } else {
                            v2::enrich_item_with_configured_provider(
                                &store, &data_dir, &item_id,
                            )
                            .await
                        };
                        match result {
                            Ok(outcome) => enrichment_notice(action, &outcome),
                            Err(error) if action == "Captured save" => Notice::info(format!(
                                "Captured save; metadata enrichment remains queued ({error})"
                            )),
                            Err(error) => Notice::error(error.to_string()),
                        }
                    }
                    Err(error) if action == "Captured save" => Notice::info(format!(
                        "Captured save; metadata enrichment remains queued ({error})"
                    )),
                    Err(error) => Notice::error(error.to_string()),
                };
                BackgroundCompletion {
                    notice,
                    preferred_id: Some(preferred_id),
                }
            }),
        });
    }

    fn operation_finished(&self) -> bool {
        self.operation
            .as_ref()
            .is_some_and(|operation| operation.handle.is_finished())
    }

    fn operation_blocks_mutations(&self) -> bool {
        self.operation
            .as_ref()
            .is_some_and(|operation| operation.blocks_mutations)
    }

    async fn finish_operation(&mut self, store: &V2Store, data_dir: &Path) {
        let Some(operation) = self.operation.take() else {
            return;
        };
        match operation.handle.await {
            Ok(completion) => {
                self.notice = Some(completion.notice);
                let _ = self
                    .refresh_or_notice(store, completion.preferred_id.as_deref())
                    .await;
            }
            Err(_) => self.notice_error("The background operation stopped unexpectedly"),
        }
        if let Some((item_id, action)) = self.queued_enrichment.pop_front() {
            self.start_enrichment(data_dir, item_id, action);
        }
    }

    async fn toggle_favorite(&mut self, store: &V2Store) {
        let Some(item) = self.selected_item().cloned() else {
            return;
        };
        let item_id = item.id.clone();
        let result = store
            .edit_item(EditItemRequest {
                item_id: item.id,
                favorite: Some(!item.favorite),
                ..EditItemRequest::default()
            })
            .await;
        match result {
            Ok(_) => {
                self.notice = Some(Notice::info(if item.favorite {
                    "Removed favorite"
                } else {
                    "Marked favorite"
                }));
                let _ = self.refresh_or_notice(store, Some(&item_id)).await;
            }
            Err(error) => self.notice_error(error),
        }
    }

    async fn delete_selected(&mut self, store: &V2Store) {
        let Some(item_id) = self.selected_item().map(|item| item.id.clone()) else {
            self.mode = Mode::Browse;
            return;
        };
        match store.delete_item(&item_id).await {
            Ok(_) => {
                self.mode = Mode::Browse;
                self.notice = Some(Notice::info("Moved save to deleted"));
                let _ = self.refresh_or_notice(store, None).await;
            }
            Err(error) => self.notice_error(error),
        }
    }

    async fn restore_selected(&mut self, store: &V2Store) {
        let Some(item) = self.selected_item().cloned() else {
            return;
        };
        if item.state != "deleted" {
            self.notice = Some(Notice::info("Selected save is already active"));
            return;
        }
        let item_id = item.id.clone();
        match store.restore_item(&item_id).await {
            Ok(_) => {
                self.notice = Some(Notice::info("Restored save"));
                let _ = self.refresh_or_notice(store, Some(&item_id)).await;
            }
            Err(error) => self.notice_error(error),
        }
    }

    async fn refresh_or_notice(&mut self, store: &V2Store, preferred_id: Option<&str>) -> bool {
        match self.refresh(store, preferred_id).await {
            Ok(()) => true,
            Err(error) => {
                self.notice_error(error);
                false
            }
        }
    }

    fn notice_error(&mut self, error: impl std::fmt::Display) {
        self.notice = Some(Notice::error(error.to_string()));
    }

    fn selected_item(&self) -> Option<&StoredItem> {
        self.items.get(self.selected)
    }

    fn select_next(&mut self, amount: usize) {
        if !self.items.is_empty() {
            self.selected = (self.selected + amount).min(self.items.len() - 1);
            self.detail_scroll = 0;
            self.sync_selection();
        }
    }

    fn select_previous(&mut self, amount: usize) {
        self.selected = self.selected.saturating_sub(amount);
        self.detail_scroll = 0;
        self.sync_selection();
    }

    fn select_first(&mut self) {
        self.selected = 0;
        self.detail_scroll = 0;
        self.sync_selection();
    }

    fn select_last(&mut self) {
        self.selected = self.items.len().saturating_sub(1);
        self.detail_scroll = 0;
        self.sync_selection();
    }

    fn sync_selection(&mut self) {
        self.list_state
            .select((!self.items.is_empty()).then_some(self.selected));
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum LifecycleFilter {
    Active,
    All,
    Deleted,
}

impl LifecycleFilter {
    fn next(self) -> Self {
        match self {
            Self::Active => Self::All,
            Self::All => Self::Deleted,
            Self::Deleted => Self::Active,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::All => "all",
            Self::Deleted => "deleted",
        }
    }
}

enum Mode {
    Browse,
    Search(TextInput),
    Form(Box<ItemForm>),
    SyncSetup(SyncForm),
    ConfirmDelete,
    Help,
}

impl Mode {
    fn kind(&self) -> ModeKind {
        match self {
            Self::Browse => ModeKind::Browse,
            Self::Search(_) => ModeKind::Search,
            Self::Form(_) => ModeKind::Form,
            Self::SyncSetup(_) => ModeKind::SyncSetup,
            Self::ConfirmDelete => ModeKind::ConfirmDelete,
            Self::Help => ModeKind::Help,
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ModeKind {
    Browse,
    Search,
    Form,
    SyncSetup,
    ConfirmDelete,
    Help,
}

struct Notice {
    text: String,
    error: bool,
}

impl Notice {
    fn info(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            error: false,
        }
    }

    fn error(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            error: true,
        }
    }
}

struct BackgroundOperation {
    label: &'static str,
    blocks_mutations: bool,
    handle: JoinHandle<BackgroundCompletion>,
}

struct BackgroundCompletion {
    notice: Notice,
    preferred_id: Option<String>,
}

struct ItemForm {
    fields: Vec<FormField>,
    active: usize,
    favorite: bool,
    enrich: bool,
    original: Option<StoredItem>,
}

impl ItemForm {
    fn create() -> Self {
        Self {
            fields: vec![
                FormField::new("URL", "", false),
                FormField::new("Title", "", false),
                FormField::new("Excerpt", "", false),
                FormField::new("Note", "", true),
                FormField::new("Tags (comma list or JSON)", "", false),
            ],
            active: 0,
            favorite: false,
            enrich: false,
            original: None,
        }
    }

    fn edit(item: StoredItem) -> Self {
        Self {
            fields: vec![
                FormField::new("URL", &item.url, false),
                FormField::new("Title", item.title.as_deref().unwrap_or_default(), false),
                FormField::new(
                    "Excerpt",
                    item.excerpt.as_deref().unwrap_or_default(),
                    false,
                ),
                FormField::new("Note", item.note.as_deref().unwrap_or_default(), true),
                FormField::new("Tags (comma list or JSON)", &format_tags(&item.tags), false),
            ],
            active: 0,
            favorite: item.favorite,
            enrich: false,
            original: Some(item),
        }
    }

    fn title(&self) -> &'static str {
        if self.original.is_some() {
            "Edit save"
        } else {
            "Capture save"
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab | KeyCode::Down | KeyCode::Enter if command_key(key) => {
                self.active = (self.active + 1) % self.focusable_count();
            }
            KeyCode::BackTab | KeyCode::Up if command_key(key) => {
                self.active = self
                    .active
                    .checked_sub(1)
                    .unwrap_or_else(|| self.focusable_count() - 1);
            }
            KeyCode::Char(' ') if self.active == self.fields.len() && command_key(key) => {
                self.favorite = !self.favorite;
            }
            KeyCode::Char(' ')
                if self.can_enrich()
                    && self.active == self.fields.len() + 1
                    && command_key(key) =>
            {
                self.enrich = !self.enrich;
            }
            KeyCode::Char('j' | 'n')
                if control_shortcut(key)
                    && self.active < self.fields.len()
                    && self.fields[self.active].multiline =>
            {
                self.fields[self.active].input.insert_char('\n');
            }
            _ if self.active < self.fields.len() => {
                let multiline = self.fields[self.active].multiline;
                self.fields[self.active].input.handle_key(key, multiline);
            }
            _ => {}
        }
    }

    fn can_enrich(&self) -> bool {
        self.original.is_none()
    }

    fn focusable_count(&self) -> usize {
        self.fields.len() + 1 + usize::from(self.can_enrich())
    }

    fn insert_text(&mut self, text: String) {
        if self.active >= self.fields.len() {
            return;
        }
        let value = if self.fields[self.active].multiline {
            text.replace("\r\n", "\n").replace('\r', "\n")
        } else {
            single_line(&text)
        };
        self.fields[self.active].input.insert_text(&value);
    }

    fn submission(&self) -> Result<FormSubmission, String> {
        let url = self.fields[0].input.value().trim().to_owned();
        let title = self.fields[1].input.value().to_owned();
        let excerpt = self.fields[2].input.value().to_owned();
        let note = self.fields[3].input.value().to_owned();
        let tags = parse_tags(&self.fields[4].input.value())?;

        let Some(original) = &self.original else {
            return Ok(FormSubmission::Create {
                request: CreateItemRequest {
                    url,
                    title: nonempty(title),
                    excerpt: nonempty(excerpt),
                    favorite: self.favorite,
                    language: None,
                    saved_at: None,
                    note,
                    tags,
                },
                enrich: self.enrich,
            });
        };

        let old_tags = original.tags.iter().cloned().collect::<BTreeSet<_>>();
        let new_tags = tags.into_iter().collect::<BTreeSet<_>>();
        let original_note = original.note.as_deref().unwrap_or_default();
        let note_changed = note != original_note;
        Ok(FormSubmission::Edit(EditItemRequest {
            item_id: original.id.clone(),
            url: (url != original.url).then_some(url),
            title: optional_text_change(original.title.as_deref(), &title),
            excerpt: optional_text_change(original.excerpt.as_deref(), &excerpt),
            favorite: (self.favorite != original.favorite).then_some(self.favorite),
            language: None,
            saved_at: None,
            note: note_changed.then_some(note),
            expected_note: note_changed.then(|| original_note.to_owned()),
            add_tags: new_tags.difference(&old_tags).cloned().collect(),
            remove_tags: old_tags.difference(&new_tags).cloned().collect(),
        }))
    }
}

enum FormSubmission {
    Create {
        request: CreateItemRequest,
        enrich: bool,
    },
    Edit(EditItemRequest),
}

struct SyncForm {
    fields: Vec<FormField>,
    active: usize,
}

impl SyncForm {
    fn new() -> Self {
        Self {
            fields: vec![
                FormField::new("Private repository (OWNER/NAME)", "", false),
                FormField::new("Branch (optional)", "", false),
            ],
            active: 0,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Tab | KeyCode::Down | KeyCode::Enter if command_key(key) => {
                self.active = (self.active + 1) % self.fields.len();
            }
            KeyCode::BackTab | KeyCode::Up if command_key(key) => {
                self.active = self.active.checked_sub(1).unwrap_or(self.fields.len() - 1);
            }
            _ => self.fields[self.active].input.handle_key(key, false),
        }
    }

    fn insert_text(&mut self, text: String) {
        self.fields[self.active]
            .input
            .insert_text(&single_line(&text));
    }

    fn submission(&self) -> Result<(String, Option<String>), String> {
        let repository = self.fields[0].input.value().trim().to_owned();
        if repository.is_empty() {
            return Err("Enter a private GitHub repository as OWNER/NAME".to_owned());
        }
        let branch = self.fields[1].input.value().trim().to_owned();
        Ok((repository, (!branch.is_empty()).then_some(branch)))
    }
}

struct FormField {
    label: &'static str,
    input: TextInput,
    multiline: bool,
}

impl FormField {
    fn new(label: &'static str, value: &str, multiline: bool) -> Self {
        Self {
            label,
            input: TextInput::new(value.to_owned()),
            multiline,
        }
    }
}

struct TextInput {
    chars: Vec<char>,
    cursor: usize,
}

impl TextInput {
    fn new(value: String) -> Self {
        let chars = value.chars().collect::<Vec<_>>();
        let cursor = chars.len();
        Self { chars, cursor }
    }

    fn value(&self) -> String {
        self.chars.iter().collect()
    }

    fn display_value(&self, focused: bool, max_width: usize) -> String {
        let marker = usize::from(focused);
        let rendered_width = UnicodeWidthStr::width(self.value().as_str()) + marker;
        if rendered_width <= max_width.max(1) {
            let mut chars = self.chars.clone();
            if focused {
                chars.insert(self.cursor, '|');
            }
            return chars.into_iter().collect();
        }

        let capacity = max_width.saturating_sub(marker + 6).max(1);
        let mut start = if focused {
            self.cursor.saturating_sub(capacity / 2)
        } else {
            0
        };
        let mut end = (start + capacity).min(self.chars.len());
        start = end.saturating_sub(capacity);
        while UnicodeWidthStr::width(self.chars[start..end].iter().collect::<String>().as_str())
            > capacity
            && end > start
        {
            if self.cursor.saturating_sub(start) > end.saturating_sub(self.cursor) {
                start += 1;
            } else {
                end -= 1;
            }
        }
        let mut visible = self.chars[start..end].to_vec();
        if focused {
            visible.insert(self.cursor.clamp(start, end) - start, '|');
        }
        format!(
            "{}{}{}",
            if start > 0 { "..." } else { "" },
            visible.into_iter().collect::<String>(),
            if end < self.chars.len() { "..." } else { "" }
        )
    }

    fn rendered_value(&self, focused: bool) -> String {
        let mut chars = self.chars.clone();
        if focused {
            chars.insert(self.cursor, '|');
        }
        chars.into_iter().collect()
    }

    fn current_line_value(&self, max_width: usize) -> String {
        let start = self.chars[..self.cursor]
            .iter()
            .rposition(|character| *character == '\n')
            .map_or(0, |position| position + 1);
        let end = self.chars[self.cursor..]
            .iter()
            .position(|character| *character == '\n')
            .map_or(self.chars.len(), |position| self.cursor + position);
        Self {
            chars: self.chars[start..end].to_vec(),
            cursor: self.cursor - start,
        }
        .display_value(true, max_width)
    }

    fn scroll_offset(&self, width: u16, height: u16) -> (u16, u16) {
        let before = self.chars[..self.cursor].iter().collect::<String>();
        let line = before.matches('\n').count();
        let column = UnicodeWidthStr::width(before.rsplit('\n').next().unwrap_or_default());
        (
            u16::try_from(line.saturating_sub(usize::from(height.saturating_sub(1))))
                .unwrap_or(u16::MAX),
            u16::try_from(column.saturating_sub(usize::from(width.saturating_sub(1))))
                .unwrap_or(u16::MAX),
        )
    }

    fn insert_char(&mut self, character: char) {
        self.chars.insert(self.cursor, character);
        self.cursor += 1;
    }

    fn insert_text(&mut self, text: &str) {
        for character in text.chars() {
            self.insert_char(character);
        }
    }

    fn handle_key(&mut self, key: KeyEvent, multiline: bool) {
        match key.code {
            KeyCode::Char('a') if control_shortcut(key) => self.cursor = 0,
            KeyCode::Char('e') if control_shortcut(key) => {
                self.cursor = self.chars.len();
            }
            KeyCode::Char('u') if control_shortcut(key) => {
                self.chars.drain(..self.cursor);
                self.cursor = 0;
            }
            KeyCode::Char(character) if text_entry_key(key) => {
                self.insert_char(character);
            }
            KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Right => self.cursor = (self.cursor + 1).min(self.chars.len()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.chars.len(),
            KeyCode::Backspace if self.cursor > 0 => {
                self.cursor -= 1;
                self.chars.remove(self.cursor);
            }
            KeyCode::Delete if self.cursor < self.chars.len() => {
                self.chars.remove(self.cursor);
            }
            KeyCode::Enter if multiline => self.insert_char('\n'),
            _ => {}
        }
    }
}

fn render(frame: &mut Frame<'_>, app: &mut App) {
    let area = frame.area();
    frame.render_widget(
        Block::default().style(Style::default().bg(Color::Black)),
        area,
    );
    if area.width < 40 || area.height < 12 {
        frame.render_widget(
            Paragraph::new(
                "ResearchPocket needs at least a 40 x 12 terminal. Resize, press Esc to close a dialog, or Ctrl+C to exit.",
            )
                .alignment(Alignment::Center)
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(2),
        ])
        .split(area);
    render_header(frame, rows[0], app);
    render_body(frame, rows[1], app);
    render_footer(frame, rows[2], app);

    match &app.mode {
        Mode::Form(form) => render_form(frame, area, form),
        Mode::SyncSetup(form) => render_sync_setup(frame, area, form, app.notice.as_ref()),
        Mode::ConfirmDelete => render_confirmation(frame, area, app.selected_item()),
        Mode::Help => render_help(frame, area),
        Mode::Browse | Mode::Search(_) => {}
    }
}

fn render_header(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let search = if app.query.is_empty() {
        "no search".to_owned()
    } else {
        format!("search: {}", terminal_safe(&app.query))
    };
    let filter = format!(
        "{} | {}{}",
        search,
        app.lifecycle.label(),
        if app.favorite_only {
            " | favorites"
        } else {
            ""
        }
    );
    let title = Line::from(vec![
        Span::styled(
            "ResearchPocket",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(filter, Style::default().fg(Color::DarkGray)),
    ]);
    frame.render_widget(
        Paragraph::new(title)
            .block(Block::default().borders(Borders::BOTTOM))
            .alignment(Alignment::Left),
        area,
    );
}

fn render_body(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    if area.width < MIN_COMFORTABLE_WIDTH || area.height < MIN_COMFORTABLE_HEIGHT {
        let parts = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(55), Constraint::Percentage(45)])
            .split(area);
        render_list(frame, parts[0], app);
        render_detail(frame, parts[1], app.selected_item(), app.detail_scroll);
    } else {
        let parts = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(44), Constraint::Percentage(56)])
            .split(area);
        render_list(frame, parts[0], app);
        render_detail(frame, parts[1], app.selected_item(), app.detail_scroll);
    }
}

fn render_list(frame: &mut Frame<'_>, area: Rect, app: &mut App) {
    let items = app
        .items
        .iter()
        .map(|item| {
            let title = item
                .title
                .as_deref()
                .filter(|title| !title.is_empty())
                .unwrap_or("Untitled");
            let marker = if item.favorite { "* " } else { "  " };
            let state = if item.state == "deleted" {
                " [deleted]"
            } else {
                ""
            };
            ListItem::new(vec![
                Line::from(format!("{marker}{}{state}", terminal_safe(title))),
                Line::from(Span::styled(
                    terminal_safe(&item.url),
                    Style::default().fg(Color::DarkGray),
                )),
            ])
        })
        .collect::<Vec<_>>();
    let title = format!(" Saves ({}) ", app.items.len());
    let list = List::new(items)
        .block(Block::default().title(title).borders(Borders::ALL))
        .highlight_symbol("> ")
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        );
    frame.render_stateful_widget(list, area, &mut app.list_state);
}

fn render_detail(frame: &mut Frame<'_>, area: Rect, item: Option<&StoredItem>, scroll: u16) {
    let text = item.map_or_else(
        || Text::from("No saves match the current view."),
        |item| {
            let mut lines = vec![
                detail_line("Title", item.title.as_deref().unwrap_or("Untitled")),
                detail_line("URL", &item.url),
                detail_line("Saved", &item.saved_at),
                detail_line("State", &item.state),
                detail_line("Favorite", if item.favorite { "yes" } else { "no" }),
                detail_line(
                    "Tags",
                    if item.tags.is_empty() {
                        "-".to_owned()
                    } else {
                        item.tags.join(", ")
                    },
                ),
            ];
            if let Some(excerpt) = &item.excerpt {
                lines.push(Line::default());
                lines.push(heading("Excerpt"));
                lines.extend(excerpt.lines().map(|line| Line::from(terminal_safe(line))));
            }
            if let Some(note) = &item.note {
                lines.push(Line::default());
                lines.push(heading("Private note"));
                lines.extend(note.lines().map(|line| Line::from(terminal_safe(line))));
            }
            lines.push(Line::default());
            lines.push(detail_line("ID", &item.id));
            Text::from(lines)
        },
    );
    frame.render_widget(
        Paragraph::new(text)
            .block(Block::default().title(" Details ").borders(Borders::ALL))
            .scroll((scroll, 0))
            .wrap(Wrap { trim: false }),
        area,
    );
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, app: &App) {
    let compact = area.width < 78;
    let mut status = if compact {
        format!(
            "{} active | {} deleted | {} pending",
            app.status.active_items, app.status.deleted_items, app.status.pending_updates
        )
    } else {
        format!(
            "{} active | {} deleted | {} pending | sync: {}",
            app.status.active_items,
            app.status.deleted_items,
            app.status.pending_updates,
            app.status.sync_state
        )
    };
    if let Some(operation) = &app.operation {
        status.push_str(" | ");
        status.push_str(operation.label);
    }
    let message = match &app.mode {
        Mode::Search(input) => Line::from(vec![
            Span::styled("Search: ", Style::default().fg(Color::Cyan)),
            Span::raw(terminal_safe(
                &input.display_value(true, usize::from(area.width.saturating_sub(28))),
            )),
            Span::styled(
                app.notice
                    .as_ref()
                    .map_or("  Enter apply | Esc cancel".to_owned(), |notice| {
                        format!("  error: {}", terminal_safe(&notice.text))
                    }),
                Style::default().fg(if app.notice.is_some() {
                    Color::Red
                } else {
                    Color::DarkGray
                }),
            ),
        ]),
        _ => {
            if let Some(notice) = &app.notice {
                Line::styled(
                    terminal_safe(&notice.text),
                    Style::default().fg(if notice.error {
                        Color::Red
                    } else {
                        Color::Green
                    }),
                )
            } else {
                Line::styled(
                    if compact {
                        "a add | E enrich | s sync | ? help | q quit"
                    } else {
                        "a add | e edit | E enrich | s sync | / search | ? help | q quit"
                    },
                    Style::default().fg(Color::DarkGray),
                )
            }
        }
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::styled(status, Style::default().fg(Color::DarkGray)),
            message,
        ]),
        area,
    );
}

fn render_form(frame: &mut Frame<'_>, area: Rect, form: &ItemForm) {
    if area.width < 50 || area.height < 24 {
        render_compact_form(frame, area, form);
        return;
    }
    let popup = centered_rect(area, 90, if form.can_enrich() { 28 } else { 26 });
    frame.render_widget(Clear, popup);
    let block = Block::default()
        .title(format!(" {} ", form.title()))
        .borders(Borders::ALL)
        .style(Style::default().bg(Color::Black));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);

    let mut constraints = vec![Constraint::Length(3); form.fields.len()];
    constraints[3] = Constraint::Min(4);
    constraints.push(Constraint::Length(2));
    if form.can_enrich() {
        constraints.push(Constraint::Length(2));
    }
    constraints.push(Constraint::Length(2));
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints)
        .split(inner);

    for (index, field) in form.fields.iter().enumerate() {
        let active = index == form.active;
        let border_style =
            Style::default().fg(if active { Color::Cyan } else { Color::DarkGray });
        let input_area = rows[index];
        let input_width = input_area.width.saturating_sub(2).max(1);
        let input_height = input_area.height.saturating_sub(2).max(1);
        let rendered = field.input.rendered_value(active);
        let rendered = if field.multiline {
            terminal_safe_multiline(&rendered)
        } else {
            terminal_safe(&rendered)
        };
        frame.render_widget(
            Paragraph::new(rendered)
                .block(
                    Block::default()
                        .title(format!(" {} ", field.label))
                        .borders(Borders::ALL)
                        .border_style(border_style),
                )
                .scroll(if active {
                    field.input.scroll_offset(input_width, input_height)
                } else {
                    (0, 0)
                }),
            rows[index],
        );
    }
    let favorite_style = if form.active == form.fields.len() {
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default()
    };
    frame.render_widget(
        Paragraph::new(format!(
            "{}{} Favorite",
            if form.active == form.fields.len() {
                "> "
            } else {
                "  "
            },
            if form.favorite { "[x]" } else { "[ ]" }
        ))
        .style(favorite_style),
        rows[form.fields.len()],
    );
    let instructions_index = if form.can_enrich() {
        let enrich_index = form.fields.len() + 1;
        let enrich_style = if form.active == enrich_index {
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        frame.render_widget(
            Paragraph::new(format!(
                "{}{} Enrich after save",
                if form.active == enrich_index {
                    "> "
                } else {
                    "  "
                },
                if form.enrich { "[x]" } else { "[ ]" }
            ))
            .style(enrich_style),
            rows[enrich_index],
        );
        enrich_index + 1
    } else {
        form.fields.len() + 1
    };
    frame.render_widget(
        Paragraph::new(vec![
            Line::from("Tab/Shift+Tab fields | Space toggles | Ctrl+N note newline"),
            Line::from("Ctrl+S save | Esc cancel"),
        ])
        .style(Style::default().fg(Color::DarkGray)),
        rows[instructions_index],
    );
}

fn render_compact_form(frame: &mut Frame<'_>, area: Rect, form: &ItemForm) {
    let popup = centered_rect(area, 48, 10);
    frame.render_widget(Clear, popup);
    let text = if let Some(field) = form.fields.get(form.active) {
        format!(
            "{}\n\n{}\n\nFavorite: {} | Enrich: {}\nTab fields | Ctrl+S save | Esc cancel",
            field.label,
            terminal_safe(
                &field
                    .input
                    .current_line_value(usize::from(popup.width.saturating_sub(4))),
            ),
            if form.favorite { "yes" } else { "no" },
            if form.can_enrich() {
                if form.enrich { "yes" } else { "no" }
            } else {
                "n/a"
            }
        )
    } else if form.active == form.fields.len() {
        format!(
            "Favorite: {}\n\nSpace toggles\nTab fields | Ctrl+S save | Esc cancel",
            if form.favorite { "yes" } else { "no" }
        )
    } else {
        format!(
            "Enrich after save: {}\n\nUses the configured provider\nSpace toggles | Ctrl+S save | Esc cancel",
            if form.enrich { "yes" } else { "no" }
        )
    };
    frame.render_widget(
        Paragraph::new(text)
            .block(
                Block::default()
                    .title(format!(" {} ", form.title()))
                    .borders(Borders::ALL),
            )
            .wrap(Wrap { trim: false }),
        popup,
    );
}

fn render_sync_setup(
    frame: &mut Frame<'_>,
    area: Rect,
    form: &SyncForm,
    notice: Option<&Notice>,
) {
    if area.width < 50 || area.height < 15 {
        render_compact_sync_setup(frame, area, form, notice);
        return;
    }
    let popup = centered_rect(area, 74, 15);
    frame.render_widget(Clear, popup);
    let block = Block::default()
        .title(" Connect GitHub sync ")
        .borders(Borders::ALL)
        .style(Style::default().bg(Color::Black));
    let inner = block.inner(popup);
    frame.render_widget(block, popup);
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Length(3),
            Constraint::Min(2),
        ])
        .split(inner);
    for (index, field) in form.fields.iter().enumerate() {
        let active = index == form.active;
        frame.render_widget(
            Paragraph::new(terminal_safe(&field.input.display_value(
                active,
                usize::from(rows[index].width.saturating_sub(4)),
            )))
            .block(
                Block::default()
                    .title(format!(" {} ", field.label))
                    .borders(Borders::ALL)
                    .border_style(Style::default().fg(if active {
                        Color::Cyan
                    } else {
                        Color::DarkGray
                    })),
            ),
            rows[index],
        );
    }
    frame.render_widget(
        Paragraph::new(
            "Uses RESEARCHPOCKET_GITHUB_TOKEN or GH_TOKEN from this process.\nTab fields | Ctrl+S connect and sync | Esc cancel",
        )
        .style(Style::default().fg(Color::DarkGray)),
        rows[2],
    );
    if let Some(notice) = notice {
        frame.render_widget(
            Paragraph::new(terminal_safe(&notice.text))
                .style(Style::default().fg(if notice.error {
                    Color::Red
                } else {
                    Color::Green
                }))
                .wrap(Wrap { trim: false }),
            rows[3],
        );
    }
}

fn render_compact_sync_setup(
    frame: &mut Frame<'_>,
    area: Rect,
    form: &SyncForm,
    notice: Option<&Notice>,
) {
    let popup = centered_rect(area, 48, 10);
    frame.render_widget(Clear, popup);
    let field = &form.fields[form.active];
    let mut lines = vec![
        Line::from(field.label),
        Line::default(),
        Line::from(terminal_safe(
            &field
                .input
                .current_line_value(usize::from(popup.width.saturating_sub(4))),
        )),
        Line::default(),
        Line::styled(
            "Tab fields | Ctrl+S connect | Esc cancel",
            Style::default().fg(Color::DarkGray),
        ),
    ];
    if let Some(notice) = notice {
        lines.push(Line::styled(
            terminal_safe(&notice.text),
            Style::default().fg(if notice.error {
                Color::Red
            } else {
                Color::Green
            }),
        ));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                Block::default()
                    .title(" Connect GitHub sync ")
                    .borders(Borders::ALL),
            )
            .wrap(Wrap { trim: false }),
        popup,
    );
}

fn render_confirmation(frame: &mut Frame<'_>, area: Rect, item: Option<&StoredItem>) {
    let popup = centered_rect(area, 58, 7);
    frame.render_widget(Clear, popup);
    let title = item
        .and_then(|item| item.title.as_deref())
        .filter(|title| !title.is_empty())
        .unwrap_or("this save");
    frame.render_widget(
        Paragraph::new(format!(
            "Delete {}?\n\nThis is recoverable. Press y/Enter to confirm or n/Esc to cancel.",
            terminal_snippet(title, usize::from(popup.width.saturating_sub(12)))
        ))
        .block(
            Block::default()
                .title(" Confirm delete ")
                .borders(Borders::ALL),
        )
        .wrap(Wrap { trim: false }),
        popup,
    );
}

fn render_help(frame: &mut Frame<'_>, area: Rect) {
    if area.width < 78 || area.height < 24 {
        let popup = centered_rect(area, 48, 10);
        frame.render_widget(Clear, popup);
        let help = [
            "j/k or arrows move | g/G first/last",
            "a add | e edit | / search",
            "E enrich | s connect/sync",
            "Space favorite | x delete | r restore",
            "f favorites | d views | R refresh",
            "Esc cancel/clear | ? close help",
            "q in library or Ctrl+C exits",
        ];
        frame.render_widget(
            Paragraph::new(help.join("\n"))
                .block(
                    Block::default()
                        .title(" Keyboard help ")
                        .borders(Borders::ALL),
                )
                .wrap(Wrap { trim: false }),
            popup,
        );
        return;
    }
    let popup = centered_rect(area, 76, 24);
    frame.render_widget(Clear, popup);
    let help = [
        "Navigation",
        "  j/k or arrows   move selection     g/G or Home/End   first/last",
        "  PgUp/PgDn       move ten            R                 refresh",
        "  Ctrl+U/Ctrl+D   scroll details",
        "",
        "Library",
        "  a add           e/Enter edit        Space toggle favorite",
        "  x delete        r restore           / search",
        "  E enrich        s connect/sync       R refresh",
        "  f favorites     d lifecycle view    Esc clear search",
        "",
        "Forms",
        "  Tab/Shift+Tab fields                Space toggles options",
        "  Ctrl+N note newline                 Ctrl+S commits one mutation",
        "  Esc cancel",
        "",
        "Enrichment uses the configured local provider. Sync uses a PAT from",
        "RESEARCHPOCKET_GITHUB_TOKEN or GH_TOKEN and never persists it.",
        "",
        "Press ?, Enter, or Esc to close help.",
    ];
    frame.render_widget(
        Paragraph::new(help.join("\n"))
            .block(
                Block::default()
                    .title(" Keyboard help ")
                    .borders(Borders::ALL),
            )
            .wrap(Wrap { trim: false }),
        popup,
    );
}

fn centered_rect(area: Rect, max_width: u16, max_height: u16) -> Rect {
    let width = max_width.min(area.width.saturating_sub(2)).max(1);
    let height = max_height.min(area.height.saturating_sub(2)).max(1);
    Rect {
        x: area.x + area.width.saturating_sub(width) / 2,
        y: area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    }
}

fn heading(text: &'static str) -> Line<'static> {
    Line::styled(
        text,
        Style::default()
            .fg(Color::Cyan)
            .add_modifier(Modifier::BOLD),
    )
}

fn detail_line<'a>(label: &'static str, value: impl Into<String>) -> Line<'a> {
    Line::from(vec![
        Span::styled(
            format!("{label}: "),
            Style::default().add_modifier(Modifier::BOLD),
        ),
        Span::raw(terminal_safe(&value.into())),
    ])
}

fn enrichment_notice(action: &str, outcome: &v2::EnrichmentAttemptOutcome) -> Notice {
    match outcome.status() {
        StoreEnrichmentStatus::Succeeded => {
            let fields = outcome.applied_fields().join(", ");
            Notice::info(format!("{action}; enriched {fields}"))
        }
        StoreEnrichmentStatus::Skipped => {
            Notice::info(format!("{action}; no eligible metadata was missing"))
        }
        StoreEnrichmentStatus::Retry => Notice::info(format!(
            "{action}; enrichment queued for retry ({})",
            outcome.last_error_kind().unwrap_or("provider_error")
        )),
        StoreEnrichmentStatus::Failed => Notice::error(format!(
            "{action}; enrichment retries exhausted ({})",
            outcome.last_error_kind().unwrap_or("provider_error")
        )),
        StoreEnrichmentStatus::InProgress => {
            Notice::info(format!("{action}; enrichment is already in progress"))
        }
        StoreEnrichmentStatus::Pending => {
            Notice::info(format!("{action}; enrichment remains queued"))
        }
    }
}

fn optional_text_change(original: Option<&str>, value: &str) -> Option<OptionalTextUpdate> {
    if original.unwrap_or_default() == value {
        None
    } else if value.is_empty() {
        Some(OptionalTextUpdate::Clear)
    } else {
        Some(OptionalTextUpdate::Set(value.to_owned()))
    }
}

fn format_tags(tags: &[String]) -> String {
    Value::Array(tags.iter().cloned().map(Value::String).collect()).to_string()
}

fn parse_tags(value: &str) -> Result<Vec<String>, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(Vec::new());
    }
    let tags = if value.starts_with('[') {
        serde_json::from_str::<Vec<String>>(value).map_err(|_| {
            "tags JSON must be an array of strings, such as [\"reading\", \"rust\"]".to_owned()
        })?
    } else {
        value
            .split(',')
            .map(str::trim)
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned)
            .collect()
    };
    if tags.iter().any(|tag| tag.trim().is_empty()) {
        return Err("tags cannot be empty or whitespace-only".to_owned());
    }
    Ok(tags
        .into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn single_line(value: &str) -> String {
    value.replace("\r\n", " ").replace(['\r', '\n'], " ")
}

fn terminal_safe(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect()
}

fn terminal_snippet(value: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    let value = terminal_safe(value);
    if UnicodeWidthStr::width(value.as_str()) <= max_width {
        return value;
    }
    let mut snippet = String::new();
    for character in value.chars() {
        snippet.push(character);
        if UnicodeWidthStr::width(snippet.as_str()) >= max_width.saturating_sub(1) {
            while UnicodeWidthStr::width(snippet.as_str()) > max_width.saturating_sub(1) {
                snippet.pop();
            }
            break;
        }
    }
    snippet.push('…');
    snippet
}

fn terminal_safe_multiline(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character == '\n' {
                '\n'
            } else if character.is_control() {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect()
}

fn control_shortcut(key: KeyEvent) -> bool {
    key.modifiers == KeyModifiers::CONTROL
}

fn command_key(key: KeyEvent) -> bool {
    !key.modifiers.intersects(
        KeyModifiers::CONTROL
            | KeyModifiers::ALT
            | KeyModifiers::SUPER
            | KeyModifiers::HYPER
            | KeyModifiers::META,
    )
}

fn text_entry_key(key: KeyEvent) -> bool {
    command_key(key)
        || key
            .modifiers
            .contains(KeyModifiers::CONTROL | KeyModifiers::ALT)
            && !key
                .modifiers
                .intersects(KeyModifiers::SUPER | KeyModifiers::HYPER | KeyModifiers::META)
}
