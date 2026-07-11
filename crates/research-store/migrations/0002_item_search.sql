CREATE VIRTUAL TABLE item_search USING fts5(
    item_id UNINDEXED,
    url,
    title,
    excerpt,
    note,
    tags,
    tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO item_search (item_id, url, title, excerpt, note, tags)
SELECT
    i.item_id,
    i.url,
    COALESCE(i.title, ''),
    COALESCE(i.excerpt, ''),
    i.note,
    COALESCE(group_concat(it.tag, ' '), '')
FROM items i
LEFT JOIN item_tags it ON it.item_id = i.item_id
GROUP BY i.item_id;
