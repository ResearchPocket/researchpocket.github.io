use crate::db::ResearchItem;

pub mod local;

pub trait Insertable {
    fn to_research_item(&self) -> ResearchItem;
}
