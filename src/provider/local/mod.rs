use crate::db::ResearchItem;

use super::Insertable;

pub struct LocalItem {
    // shouldn't be needed for local items
    pub id: Option<i64>,
    pub uri: String,
    pub title: Option<String>,
    pub excerpt: Option<String>,
    pub time_added: i64,
}

impl Insertable for LocalItem {
    fn to_research_item(&self) -> crate::db::ResearchItem {
        ResearchItem {
            id: self.id,
            uri: self.uri.clone(),
            title: self.title.clone().unwrap_or("Untitled".to_string()),
            excerpt: self.excerpt.clone().unwrap_or("".to_string()),
            time_added: self.time_added,
            favorite: false,
            lang: Some("en".into()),
            notes: None,
        }
    }
}
