use crate::db::{ResearchItem, Tags};
use chrono::{DateTime, Local, TimeZone, Utc};
use chrono_tz::Tz;
use sailfish::TemplateOnce;
use serde::Serialize;
use std::fmt::Display;
use std::sync::RwLock;

pub struct Site {
    pub index_html: String,
    pub search_html: String,
}

#[derive(TemplateOnce, Serialize)]
#[template(path = "index.stpl")]
#[template(rm_whitespace = true)]
struct IndexTemplate<'a> {
    title: &'a str,
    assets_dir: &'a str,
    tags: Vec<&'a str>,
    item_tags: &'a [(Vec<&'a str>, PublishedItem<'a>)],
}

#[derive(TemplateOnce, Serialize)]
#[template(path = "search.stpl")]
#[template(rm_whitespace = true)]
struct SearchTemplate<'a> {
    title: &'a str,
    assets_dir: &'a str,
    item_tags_json: String,
    tags: Vec<&'a str>,
}

#[derive(Clone, Serialize)]
struct PublishedItem<'a> {
    pub uri: &'a str,
    pub title: &'a str,
    pub excerpt: &'a str,
    pub time_added: i64,
    pub favorite: bool,
}

impl PublishedItem<'_> {
    fn format_time_added(&self, timezone: Option<Tz>) -> String {
        let utc_datetime = Utc.timestamp_opt(self.time_added, 0).unwrap();
        fn format_datetime<Tz: TimeZone>(datetime: DateTime<Tz>) -> String
        where
            Tz::Offset: Display,
        {
            datetime.format("%d %b'%y, %l%P").to_string()
        }

        match timezone {
            Some(tz) => format_datetime(utc_datetime.with_timezone(&tz)),
            None => format_datetime(utc_datetime.with_timezone(&Local)),
        }
    }
}

impl<'a> From<&'a ResearchItem> for PublishedItem<'a> {
    fn from(item: &'a ResearchItem) -> Self {
        Self {
            uri: &item.uri,
            title: &item.title,
            excerpt: &item.excerpt,
            time_added: item.time_added,
            favorite: item.favorite,
        }
    }
}

#[derive(Serialize)]
struct PublishedItemWithTags<'a> {
    pub tags: Vec<&'a str>,
    #[serde(flatten)]
    pub item: PublishedItem<'a>,
}

static TIMEZONE: RwLock<Option<Tz>> = RwLock::new(None);

const TITLE: &str = "Pocket Research";

impl Site {
    pub fn build(
        tags: &[Tags],
        item_tags: &[(Vec<Tags>, ResearchItem)],
        assets_dir: &str,
        timezone: Option<Tz>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        {
            let mut timezone_lock = TIMEZONE.write().unwrap();
            *timezone_lock = timezone;
        }
        let tags = tags.iter().map(|t| t.tag_name.as_str()).collect::<Vec<_>>();
        let published_items = item_tags
            .iter()
            .map(|(tags, item)| {
                (
                    tags.iter().map(|tag| tag.tag_name.as_str()).collect(),
                    PublishedItem::from(item),
                )
            })
            .collect::<Vec<_>>();
        let ctx = IndexTemplate {
            title: TITLE,
            item_tags: &published_items,
            assets_dir,
            tags: tags.clone(),
        };

        let index_html = ctx.render_once()?;

        let item_tags = item_tags
            .iter()
            .map(|(tags, item)| PublishedItemWithTags {
                tags: tags.iter().map(|t| t.tag_name.as_str()).collect(),
                item: PublishedItem::from(item),
            })
            .collect::<Vec<_>>();
        let item_tags_json = inline_script_json(&item_tags)?;

        let ctx = SearchTemplate {
            item_tags_json,
            assets_dir,
            title: "Search",
            tags: tags.clone(),
        };
        let search_html = ctx.render_once()?;
        Ok(Self {
            index_html,
            search_html,
        })
    }
}

fn inline_script_json<T: Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_string(value).map(|json| {
        json.replace('&', "\\u0026")
            .replace('<', "\\u003c")
            .replace('>', "\\u003e")
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029")
    })
}

#[cfg(test)]
mod tests {
    use super::Site;
    use crate::db::{ResearchItem, Tags};

    #[test]
    fn generated_site_exposes_only_allowlisted_fields() {
        let private_note = "PRIVATE_TOKEN_123</script><script>alert('leak')</script>";
        let items = vec![(
            vec![Tags {
                tag_name: "public-tag".to_owned(),
            }],
            ResearchItem {
                id: Some(8675309),
                uri: "https://example.com/public-item".to_owned(),
                title: "Public title".to_owned(),
                excerpt: "Public excerpt".to_owned(),
                time_added: 1_700_000_000,
                favorite: true,
                lang: Some("PRIVATE_LANGUAGE_SENTINEL".to_owned()),
                notes: Some(private_note.to_owned()),
            },
        )];

        let site = Site::build(&items[0].0, &items, "./assets", None).unwrap();
        let generated = format!("{}\n{}", site.index_html, site.search_html);

        for public_value in [
            "https://example.com/public-item",
            "Public title",
            "Public excerpt",
            "public-tag",
        ] {
            assert!(generated.contains(public_value));
        }
        for private_value in [
            private_note,
            "PRIVATE_TOKEN_123",
            "PRIVATE_LANGUAGE_SENTINEL",
            "8675309",
            "\"notes\"",
            "\"lang\"",
            "\"id\"",
            "</script><script>",
        ] {
            assert!(!generated.contains(private_value));
        }
    }
}
