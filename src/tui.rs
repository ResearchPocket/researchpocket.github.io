use crate::db::ResearchItem;
use color_eyre::eyre::Result;
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use ratatui::{
    backend::Backend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style, Stylize},
    text::{Line, Span}, // Added Line and Span
    widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap}, // Added Clear
    Frame, Terminal,
};
use chrono::NaiveDateTime;

#[derive(Clone, Copy, Debug, PartialEq)] // Added derive for previous_view comparison
pub enum CurrentView {
    List,
    Detail,
    Filtering, // New view state for inputting filter text
    Help,      // New view state for displaying help
}

pub struct TuiApp {
    pub items: Vec<ResearchItem>, // Will hold filtered items
    original_items: Vec<ResearchItem>, // Holds all items
    pub list_state: ListState,
    current_view: CurrentView,
    previous_view: CurrentView, // To store view before opening Help
    filter_input: String,
    pub exit: bool,
}

impl TuiApp {
    pub fn new(db_items: Vec<ResearchItem>) -> Self {
        let mut list_state = ListState::default();
        if !db_items.is_empty() {
            list_state.select(Some(0));
        }
        Self {
            items: db_items.clone(), // Initially, items are all original_items
            original_items: db_items,
            list_state,
            current_view: CurrentView::List,
            previous_view: CurrentView::List, // Initialize previous_view
            filter_input: String::new(),
            exit: false,
        }
    }

    // Method to switch to detail view
    fn view_details(&mut self) {
        if self.list_state.selected().is_some() {
            self.current_view = CurrentView::Detail;
        }
    }

    // Method to switch back to list view
    fn back_to_list(&mut self) {
        self.current_view = CurrentView::List;
    }

    // Method to start filtering
    fn start_filtering(&mut self) {
        self.current_view = CurrentView::Filtering;
    }

    // Method to show help view
    fn show_help(&mut self) {
        // Avoid overwriting if already in Help or if previous_view is Help itself
        if !matches!(self.current_view, CurrentView::Help) {
            self.previous_view = self.current_view; // Store the view before switching
        }
        self.current_view = CurrentView::Help;
    }

    // Method to close help view
    fn close_help(&mut self) {
        self.current_view = self.previous_view; // Restore the previous view
    }

    // Method to apply filter
    fn apply_filter(&mut self) {
        if self.filter_input.is_empty() {
            self.items = self.original_items.clone();
        } else {
            let filter_lowercase = self.filter_input.to_lowercase();
            self.items = self.original_items
                .iter()
                .filter(|item| {
                    item.title.as_deref().unwrap_or("").to_lowercase().contains(&filter_lowercase) ||
                    item.uri.to_lowercase().contains(&filter_lowercase) ||
                    item.excerpt.as_deref().unwrap_or("").to_lowercase().contains(&filter_lowercase) ||
                    item.notes.as_deref().unwrap_or("").to_lowercase().contains(&filter_lowercase)
                    // TODO: Add filtering by tags once tags are part of ResearchItem or accessible here
                })
                .cloned()
                .collect();
        }
        self.current_view = CurrentView::List;
        self.list_state.select(if self.items.is_empty() { None } else { Some(0) });
    }

    // Method to cancel filtering (when Esc is pressed in Filtering view)
    fn cancel_filtering(&mut self) {
        self.filter_input.clear();
        self.items = self.original_items.clone(); // Restore all items
        self.current_view = CurrentView::List;
        self.list_state.select(if self.items.is_empty() { None } else { Some(0) }); // Reset selection
    }

    // Method to clear an active filter (when Esc is pressed in List view)
    // This is effectively the same as cancel_filtering if the user isn't in Filtering mode.
    // Renamed clear_active_filter to this for consistency if called from List view.
    pub fn clear_filter_and_restore_all(&mut self) {
        self.filter_input.clear();
        self.items = self.original_items.clone();
        self.list_state.select(if self.items.is_empty() { None } else { Some(0) });
        // current_view remains List, or if it was Filtering, it should be reset by caller or another method.
    }


    pub fn next(&mut self) {
        if self.items.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => {
                if i >= self.items.len() - 1 {
                    0
                } else {
                    i + 1
                }
            }
            None => 0,
        };
        self.list_state.select(Some(i));
        // self.selected_index = i; // No longer explicitly needed
    }

    pub fn previous(&mut self) {
        if self.items.is_empty() {
            return;
        }
        let i = match self.list_state.selected() {
            Some(i) => {
                if i == 0 {
                    self.items.len() - 1
                } else {
                    i - 1
                }
            }
            None => 0,
        };
        self.list_state.select(Some(i));
        // self.selected_index = i; // No longer explicitly needed
    }

    pub fn quit(&mut self) {
        self.exit = true;
    }
}

fn render_list_view<B: Backend>(f: &mut Frame<B>, app: &mut TuiApp, area: Rect) {
    let items: Vec<ListItem> = app
        .items
        .iter()
        .map(|i| {
            let title = i.title.as_deref().unwrap_or("No title").to_string();
            ListItem::new(title)
        })
        .collect();

    let list = List::new(items)
        .block(
            Block::default()
                .title("Articles - (j/k, Enter, q, /, h)") // Added h for help
                .borders(Borders::ALL),
        )
        .highlight_style(
            Style::default()
                .add_modifier(Modifier::BOLD)
                .bg(Color::DarkGray), // Changed highlight background for better visibility
        )
        .highlight_symbol("> ");

    f.render_stateful_widget(list, area, &mut app.list_state);
}

fn render_detail_view<B: Backend>(f: &mut Frame<B>, app: &mut TuiApp, area: Rect) {
    if let Some(selected_idx) = app.list_state.selected() {
        if let Some(item) = app.items.get(selected_idx) {
            let details_text = format!(
                "Title: {}\n\nURL: {}\n\nAdded: {}\nFavorite: {}\nLanguage: {}\n\nExcerpt:\n{}\n\nNotes:\n{}",
                item.title.as_deref().unwrap_or("N/A"),
                item.uri,
                NaiveDateTime::from_timestamp_opt(item.time_added, 0)
                    .map(|dt| dt.format("%Y-%m-%d %H:%M:%S UTC").to_string())
                    .unwrap_or_else(|| "N/A".to_string()),
                item.favorite,
                item.lang.as_deref().unwrap_or("N/A"),
                item.excerpt.as_deref().unwrap_or("N/A"),
                item.notes.as_deref().unwrap_or("N/A")
            );

            let paragraph = Paragraph::new(details_text)
                .wrap(Wrap { trim: true }) // Enable wrapping
                .block(
                    Block::default()
                        .title("Article Details - (Esc/b, q, h)") // Added h for help
                        .borders(Borders::ALL),
                );
            f.render_widget(paragraph, area);
        } else {
            let paragraph = Paragraph::new("Error: Could not retrieve item details.")
                .block(Block::default().title("Error").borders(Borders::ALL));
            f.render_widget(paragraph, area);
        }
    } else {
        // This case should ideally not be reached if view_details checks for selection
        let paragraph = Paragraph::new("No item selected.")
            .block(Block::default().title("Info").borders(Borders::ALL));
        f.render_widget(paragraph, area);
    }
}

pub fn ui<B: Backend>(f: &mut Frame<B>, app: &mut TuiApp) {
    // Define layout based on whether the filter bar is visible
    let filter_bar_height = if matches!(app.current_view, CurrentView::Filtering) || !app.filter_input.is_empty() {
        3
    } else {
        0
    };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1) // Margin for the whole screen
        .constraints(
            [
                Constraint::Min(0), // Main content (list or detail)
                Constraint::Length(filter_bar_height), // Filter input bar
            ]
            .as_ref(),
        )
        .split(f.size());

    let main_content_area = chunks[0];
    let filter_area = chunks[1];

    // Render main content based on current view
    match app.current_view {
        CurrentView::List | CurrentView::Filtering => {
            render_list_view(f, app, main_content_area);
        }
        CurrentView::Detail => {
            render_detail_view(f, app, main_content_area);
        }
        CurrentView::Help => {
            // Help view is rendered last and can be full screen or a popup
            // For full screen, it uses main_content_area or even f.size()
        }
    }

    // Render the filter input bar if visible and not in Help view
    if filter_bar_height > 0 && !matches!(app.current_view, CurrentView::Help) {
        let filter_text = if matches!(app.current_view, CurrentView::Filtering) {
            format!("Filter: {}_", app.filter_input)
        } else {
            format!("Active Filter: {} (Press '/' to edit, 'Esc' to clear filter)", app.filter_input)
        };
        let title = if matches!(app.current_view, CurrentView::Filtering) {
            "Input Filter (Enter to apply, Esc to cancel input)"
        } else {
            "Active Filter"
        };
        let input_paragraph = Paragraph::new(filter_text)
            .block(Block::default().title(title).borders(Borders::ALL));
        f.render_widget(input_paragraph, filter_area);
    }
    
    // Render Help view last if it's active (so it overlays other content if not full screen)
    if matches!(app.current_view, CurrentView::Help) {
        render_help_view(f, app, f.size()); // Render full screen
    }
}

fn render_help_view<B: Backend>(f: &mut Frame<B>, app: &TuiApp, area: Rect) {
    let mut help_lines = vec![
        Line::from(Span::styled("Keybindings Help", Style::default().add_modifier(Modifier::BOLD))),
        Line::from(Span::raw("")), // Spacer
        Line::from(Span::raw("General:")),
        Line::from(Span::raw("  h / ?: Toggle Help")),
        Line::from(Span::raw("  q: Quit Application")),
        Line::from(Span::raw("")),
    ];

    match app.previous_view {
        CurrentView::List | CurrentView::Filtering => {
            help_lines.extend(vec![
                Line::from(Span::raw("List View / Filtering Active:")),
                Line::from(Span::raw("  j / ↓: Next item")),
                Line::from(Span::raw("  k / ↑: Previous item")),
                Line::from(Span::raw("  Enter: View details")),
                Line::from(Span::raw("  /: Enter filter mode / Edit filter")),
                Line::from(Span::raw("  Esc: Clear active filter (if filter active) / Exit filter input mode")),
            ]);
            if matches!(app.previous_view, CurrentView::Filtering) {
                 help_lines.extend(vec![
                    Line::from(Span::raw("")),
                    Line::from(Span::raw("Filtering Mode (when typing filter):")),
                    Line::from(Span::raw("  Enter: Apply filter")),
                    Line::from(Span::raw("  Esc: Cancel input & clear filter text, back to list")),
                    Line::from(Span::raw("  Backspace: Delete last character")),
                ]);
            }
        }
        CurrentView::Detail => {
            help_lines.extend(vec![
                Line::from(Span::raw("Detail View:")),
                Line::from(Span::raw("  b / Esc: Back to list")),
                // Line::from(Span::raw("  o: Open in browser (TODO)")), // TODO
            ]);
        }
        CurrentView::Help => { /* Should not happen if logic is correct, previous_view won't be Help */ }
    }
    help_lines.extend(vec![
        Line::from(Span::raw("")),
        Line::from(Span::raw("Press 'h', 'q', or 'Esc' to close this help.")),
    ]);

    let help_paragraph = Paragraph::new(help_lines)
        .block(Block::default().title("Help").borders(Borders::ALL))
        .wrap(Wrap { trim: true }); // trim: true to avoid partial lines at the end

    f.render_widget(Clear, area); // Clear the area before rendering help
    f.render_widget(help_paragraph, area);
}


pub fn handle_events(app: &mut TuiApp) -> Result<()> {
    if event::poll(std::time::Duration::from_millis(50))? {
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press {
                match app.current_view {
                    CurrentView::List => match key.code {
                        KeyCode::Char('q') => app.quit(),
                        KeyCode::Down | KeyCode::Char('j') => app.next(),
                        KeyCode::Up | KeyCode::Char('k') => app.previous(),
                        KeyCode::Enter => app.view_details(),
                        KeyCode::Char('/') => app.start_filtering(),
                        KeyCode::Char('h') | KeyCode::Char('?') => app.show_help(),
                        KeyCode::Esc => {
                            if !app.filter_input.is_empty() {
                                app.clear_filter_and_restore_all();
                            }
                        }
                        _ => {}
                    },
                    CurrentView::Detail => match key.code {
                        KeyCode::Char('q') => app.quit(),
                        KeyCode::Esc | KeyCode::Char('b') => app.back_to_list(),
                        KeyCode::Char('h') | KeyCode::Char('?') => app.show_help(),
                        _ => {}
                    },
                    CurrentView::Filtering => match key.code {
                        KeyCode::Char(c) => app.filter_input.push(c),
                        KeyCode::Backspace => { app.filter_input.pop(); },
                        KeyCode::Enter => app.apply_filter(),
                        KeyCode::Esc => app.cancel_filtering(),
                        // No help from filtering mode directly, user should Esc then h
                        _ => {}
                    },
                    CurrentView::Help => match key.code {
                        KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('h') => app.close_help(),
                        _ => {}
                    },
                }
            }
        }
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::ResearchItem; // Assuming db module is accessible like this
    use ratatui::widgets::ListState;

    fn create_test_item(id: i64, title: &str, uri: &str, excerpt: &str, notes: &str) -> ResearchItem {
        ResearchItem {
            id: Some(id),
            title: Some(title.to_string()),
            uri: uri.to_string(),
            excerpt: Some(excerpt.to_string()),
            time_added: chrono::Utc::now().timestamp(),
            favorite: false,
            lang: Some("en".to_string()),
            notes: Some(notes.to_string()),
        }
    }

    fn get_sample_items() -> Vec<ResearchItem> {
        vec![
            create_test_item(1, "Item 1", "uri1", "excerpt one", "note for one"),
            create_test_item(2, "Item 2", "uri2", "excerpt two", "note for two"),
            create_test_item(3, "Item 3", "uri3", "excerpt three", "note for three"),
        ]
    }

    #[test]
    fn test_tui_app_new_initialization() {
        let items = get_sample_items();
        let app_with_items = TuiApp::new(items.clone());

        assert_eq!(app_with_items.current_view, CurrentView::List);
        assert_eq!(app_with_items.previous_view, CurrentView::List);
        assert_eq!(app_with_items.filter_input, "");
        assert_eq!(app_with_items.original_items.len(), items.len());
        assert_eq!(app_with_items.items.len(), items.len());
        assert_eq!(app_with_items.list_state.selected(), Some(0));
        assert!(!app_with_items.exit);

        let app_empty = TuiApp::new(vec![]);
        assert_eq!(app_empty.list_state.selected(), None);
        assert_eq!(app_empty.items.len(), 0);
        assert_eq!(app_empty.original_items.len(), 0);
    }

    #[test]
    fn test_list_navigation_next() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items);

        app.next();
        assert_eq!(app.list_state.selected(), Some(1));
        app.next();
        assert_eq!(app.list_state.selected(), Some(2));
        app.next(); // Wrap around
        assert_eq!(app.list_state.selected(), Some(0));

        // Test on empty list
        let mut app_empty = TuiApp::new(vec![]);
        app_empty.next();
        assert_eq!(app_empty.list_state.selected(), None);
    }

    #[test]
    fn test_list_navigation_previous() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items);

        app.previous(); // Wrap around
        assert_eq!(app.list_state.selected(), Some(2));
        app.previous();
        assert_eq!(app.list_state.selected(), Some(1));
        app.previous();
        assert_eq!(app.list_state.selected(), Some(0));

        // Test on empty list
        let mut app_empty = TuiApp::new(vec![]);
        app_empty.previous();
        assert_eq!(app_empty.list_state.selected(), None);
    }

    #[test]
    fn test_view_switching() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items.clone());

        // view_details
        app.view_details();
        assert_eq!(app.current_view, CurrentView::Detail);

        // view_details with no selection (e.g. after filter clears selection)
        let mut app_no_selection = TuiApp::new(items.clone());
        app_no_selection.list_state.select(None); // Force no selection
        app_no_selection.view_details();
        assert_eq!(app_no_selection.current_view, CurrentView::List); // Should not switch

        // back_to_list
        app.current_view = CurrentView::Detail; // Set it first
        app.back_to_list();
        assert_eq!(app.current_view, CurrentView::List);

        // start_filtering
        app.start_filtering();
        assert_eq!(app.current_view, CurrentView::Filtering);

        // show_help
        app.current_view = CurrentView::List; // Reset to a known state
        app.show_help();
        assert_eq!(app.current_view, CurrentView::Help);
        assert_eq!(app.previous_view, CurrentView::List);

        app.current_view = CurrentView::Detail; // From Detail view
        app.show_help();
        assert_eq!(app.current_view, CurrentView::Help);
        assert_eq!(app.previous_view, CurrentView::Detail);
        
        // show_help when already in help (previous_view should not change to Help)
        app.previous_view = CurrentView::List; // Set a specific previous_view
        app.current_view = CurrentView::Help;
        app.show_help();
        assert_eq!(app.current_view, CurrentView::Help);
        assert_eq!(app.previous_view, CurrentView::List); // Should remain the original previous_view


        // close_help
        app.current_view = CurrentView::Help;
        app.previous_view = CurrentView::Detail; // Simulate coming from Detail
        app.close_help();
        assert_eq!(app.current_view, CurrentView::Detail);
    }

    #[test]
    fn test_filtering_logic_apply_filter() {
        let items = vec![
            create_test_item(1, "Rust Dev", "rust-lang.org", "Rust programming", "notes on rust"),
            create_test_item(2, "Python Code", "python.org", "Python scripting", "notes on python"),
            create_test_item(3, "General Tech", "tech.com", "Various technologies", "general notes"),
        ];
        let mut app = TuiApp::new(items.clone());

        // Empty filter_input
        app.filter_input = "".to_string();
        app.apply_filter();
        assert_eq!(app.items.len(), 3);
        assert_eq!(app.current_view, CurrentView::List);

        // Filter by title (case-insensitive)
        app.filter_input = "rust".to_string();
        app.apply_filter();
        assert_eq!(app.items.len(), 1);
        assert_eq!(app.items[0].id, Some(1));
        assert_eq!(app.current_view, CurrentView::List);
        assert_eq!(app.list_state.selected(), Some(0));

        // Filter by URI
        app.filter_input = "python.org".to_string();
        app.apply_filter();
        assert_eq!(app.items.len(), 1);
        assert_eq!(app.items[0].id, Some(2));

        // Filter by excerpt
        app.filter_input = "technologies".to_string();
        app.apply_filter();
        assert_eq!(app.items.len(), 1);
        assert_eq!(app.items[0].id, Some(3));

        // Filter by notes
        app.filter_input = "NOTES ON PYTHON".to_string(); // Case-insensitive
        app.apply_filter();
        assert_eq!(app.items.len(), 1);
        assert_eq!(app.items[0].id, Some(2));

        // No match
        app.filter_input = "nomatchfilter".to_string();
        app.apply_filter();
        assert_eq!(app.items.len(), 0);
        assert_eq!(app.list_state.selected(), None);
    }

    #[test]
    fn test_filtering_logic_cancel_filtering() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items.clone());

        app.filter_input = "test".to_string();
        // Simulate some filtering has happened
        app.items = vec![items[0].clone()]; 
        app.current_view = CurrentView::Filtering;

        app.cancel_filtering();

        assert_eq!(app.filter_input, "");
        assert_eq!(app.items.len(), items.len()); // Restored to original
        assert_eq!(app.current_view, CurrentView::List);
        assert_eq!(app.list_state.selected(), Some(0)); // Selection reset
    }

    #[test]
    fn test_filtering_logic_clear_filter_and_restore_all() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items.clone());

        app.filter_input = "test".to_string();
        // Simulate some filtering has happened
        app.items = vec![items[0].clone()];
        app.current_view = CurrentView::List; // This is called from List view

        app.clear_filter_and_restore_all();

        assert_eq!(app.filter_input, "");
        assert_eq!(app.items.len(), items.len()); // Restored to original
        assert_eq!(app.current_view, CurrentView::List); // Remains List
        assert_eq!(app.list_state.selected(), Some(0)); // Selection reset
    }
    
    // Helper to simulate key events for handle_events tests
    // Note: This is a simplified way to test handle_events logic.
    // It doesn't involve the actual crossterm event polling or terminal.
    fn simulate_key_press(app: &mut TuiApp, code: KeyCode) {
        // We assume KeyEventKind::Press for these tests as that's what handle_events checks
        let event = Event::Key(crossterm::event::KeyEvent::new(
            code,
            crossterm::event::KeyModifiers::empty(),
        ));
        
        // Manually call the logic within handle_events based on the event structure
        // This is a direct way to test the app's reaction to key presses
        // without needing to mock the full event polling mechanism.
        // This code structure mirrors the one in the actual handle_events.
        if let Event::Key(key_event) = event {
            if key_event.kind == KeyEventKind::Press {
                 match app.current_view {
                    CurrentView::List => match key_event.code {
                        KeyCode::Char('q') => app.quit(),
                        KeyCode::Down | KeyCode::Char('j') => app.next(),
                        KeyCode::Up | KeyCode::Char('k') => app.previous(),
                        KeyCode::Enter => app.view_details(),
                        KeyCode::Char('/') => app.start_filtering(),
                        KeyCode::Char('h') | KeyCode::Char('?') => app.show_help(),
                        KeyCode::Esc => {
                            if !app.filter_input.is_empty() {
                                app.clear_filter_and_restore_all();
                            }
                        }
                        _ => {}
                    },
                    CurrentView::Detail => match key_event.code {
                        KeyCode::Char('q') => app.quit(),
                        KeyCode::Esc | KeyCode::Char('b') => app.back_to_list(),
                        KeyCode::Char('h') | KeyCode::Char('?') => app.show_help(),
                        _ => {}
                    },
                    CurrentView::Filtering => match key_event.code {
                        KeyCode::Char(c) => app.filter_input.push(c),
                        KeyCode::Backspace => { app.filter_input.pop(); },
                        KeyCode::Enter => app.apply_filter(),
                        KeyCode::Esc => app.cancel_filtering(),
                        _ => {}
                    },
                    CurrentView::Help => match key_event.code {
                        KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('h') => app.close_help(),
                        _ => {}
                    },
                }
            }
        }
    }

    #[test]
    fn test_handle_events_list_view_navigation() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items);

        // Test 'j' for next
        simulate_key_press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.list_state.selected(), Some(1));

        // Test Down arrow for next
        simulate_key_press(&mut app, KeyCode::Down);
        assert_eq!(app.list_state.selected(), Some(2));
        
        // Test 'k' for previous
        simulate_key_press(&mut app, KeyCode::Char('k'));
        assert_eq!(app.list_state.selected(), Some(1));

        // Test Up arrow for previous
        simulate_key_press(&mut app, KeyCode::Up);
        assert_eq!(app.list_state.selected(), Some(0));
    }

    #[test]
    fn test_handle_events_view_changes_from_list() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items);

        // Test Enter to view_details
        simulate_key_press(&mut app, KeyCode::Enter);
        assert_eq!(app.current_view, CurrentView::Detail);
        
        // Reset view
        app.current_view = CurrentView::List;

        // Test '/' to start_filtering
        simulate_key_press(&mut app, KeyCode::Char('/'));
        assert_eq!(app.current_view, CurrentView::Filtering);

        // Reset view
        app.current_view = CurrentView::List;

        // Test 'h' to show_help
        simulate_key_press(&mut app, KeyCode::Char('h'));
        assert_eq!(app.current_view, CurrentView::Help);
        assert_eq!(app.previous_view, CurrentView::List);
    }
    
    #[test]
    fn test_handle_events_filtering_input() {
        let items = get_sample_items();
        let mut app = TuiApp::new(items);
        app.current_view = CurrentView::Filtering; // Set to filtering mode

        simulate_key_press(&mut app, KeyCode::Char('t'));
        simulate_key_press(&mut app, KeyCode::Char('e'));
        simulate_key_press(&mut app, KeyCode::Char('s'));
        assert_eq!(app.filter_input, "tes");

        simulate_key_press(&mut app, KeyCode::Backspace);
        assert_eq!(app.filter_input, "te");
        
        // Test Enter to apply filter
        simulate_key_press(&mut app, KeyCode::Enter);
        assert_eq!(app.current_view, CurrentView::List); 
        // Further checks on filtered items could be here, similar to test_filtering_logic_apply_filter

        // Test Esc to cancel filtering
        app.current_view = CurrentView::Filtering;
        app.filter_input = "some input".to_string();
        simulate_key_press(&mut app, KeyCode::Esc);
        assert_eq!(app.current_view, CurrentView::List);
        assert_eq!(app.filter_input, ""); // cancel_filtering clears it
        assert_eq!(app.items.len(), app.original_items.len()); // Restored
    }

    #[test]
    fn test_handle_events_help_view() {
        let mut app = TuiApp::new(vec![]);
        app.current_view = CurrentView::Help;
        app.previous_view = CurrentView::List;

        simulate_key_press(&mut app, KeyCode::Char('h'));
        assert_eq!(app.current_view, CurrentView::List); // Closed help

        app.current_view = CurrentView::Help; // Re-open
        simulate_key_press(&mut app, KeyCode::Esc);
        assert_eq!(app.current_view, CurrentView::List); // Closed help
    }

    #[test]
    fn test_handle_events_quit() {
        let mut app = TuiApp::new(vec![]);
        
        app.current_view = CurrentView::List;
        simulate_key_press(&mut app, KeyCode::Char('q'));
        assert!(app.exit);

        app.exit = false; // Reset
        app.current_view = CurrentView::Detail;
        simulate_key_press(&mut app, KeyCode::Char('q'));
        assert!(app.exit);
        
        // Note: Filtering view doesn't have 'q' to quit directly, user Escapes first
        // Help view 'q' also closes help, not quits app.
        app.exit = false;
        app.current_view = CurrentView::Help;
        app.previous_view = CurrentView::List;
        simulate_key_press(&mut app, KeyCode::Char('q'));
        assert!(!app.exit); // q closes help, not exits app
        assert_eq!(app.current_view, CurrentView::List);
    }
}

pub fn run_app<B: Backend>(
    terminal: &mut Terminal<B>,
    mut app: TuiApp,
) -> Result<()> {
    loop {
        terminal.draw(|f| ui(f, &mut app))?;
        handle_events(&mut app)?;
        if app.exit {
            break;
        }
    }
    Ok(())
}
