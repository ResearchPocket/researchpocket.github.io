//! The narrowest-splice contract behind #115.

use research_domain::TextSplice;

fn splice(current: &str, replacement: &str) -> TextSplice {
    TextSplice::between(current, replacement).expect("the strings differ")
}

/// Applying the splice must reproduce the replacement exactly.
fn apply(current: &str, splice: &TextSplice) -> String {
    let units: Vec<u16> = current.encode_utf16().collect();
    let mut result: Vec<u16> = units[..splice.position].to_vec();
    result.extend(splice.insert.encode_utf16());
    result.extend_from_slice(&units[splice.position + splice.length..]);
    String::from_utf16(&result).expect("well-formed UTF-16")
}

#[test]
fn an_unchanged_note_produces_no_splice() {
    assert_eq!(TextSplice::between("same", "same"), None);
    assert_eq!(TextSplice::between("", ""), None);
}

#[test]
fn appending_touches_only_the_tail() {
    let result = splice("hello", "hello!");
    assert_eq!(result.position, 5);
    assert_eq!(result.length, 0);
    assert_eq!(result.insert, "!");
}

#[test]
fn prepending_touches_only_the_head() {
    let result = splice("hello", "oh hello");
    assert_eq!(result.position, 0);
    assert_eq!(result.length, 0);
    assert_eq!(result.insert, "oh ");
}

#[test]
fn an_interior_edit_touches_only_the_middle() {
    let result = splice("the quick brown fox", "the slow brown fox");
    assert_eq!(result.insert, "slow");
    assert_eq!(result.position, 4);
    assert_eq!(result.length, 5);
}

#[test]
fn deleting_reports_a_range_with_no_insert() {
    let result = splice("keep this away", "keep away");
    assert_eq!(result.insert, "");
    assert_eq!(result.length, 5);
}

#[test]
fn clearing_removes_everything() {
    let result = splice("gone", "");
    assert_eq!(result.position, 0);
    assert_eq!(result.length, 4);
    assert_eq!(result.insert, "");
}

#[test]
fn a_one_character_edit_in_a_long_note_stays_small() {
    let long: String = "word ".repeat(2_000);
    let edited = format!("{long}.");
    let result = splice(&long, &edited);

    assert_eq!(result.insert, ".");
    assert_eq!(result.length, 0);
    assert_eq!(apply(&long, &result), edited);
}

#[test]
fn surrogate_pairs_are_never_split() {
    // The emoji occupies two UTF-16 code units.
    let current = "A😀B";
    let replacement = "A😀C";
    let result = splice(current, replacement);

    assert_eq!(apply(current, &result), replacement);
    assert_eq!(result.insert, "C");
    assert_eq!(
        result.position, 3,
        "the boundary must sit after the whole pair"
    );
}

#[test]
fn replacing_an_emoji_keeps_both_halves_together() {
    let current = "A😀B";
    let replacement = "A🙂B";
    let result = splice(current, replacement);

    assert_eq!(apply(current, &result), replacement);
    assert_eq!(result.insert, "🙂");
    assert_eq!(result.position, 1);
    assert_eq!(result.length, 2, "both halves of the old pair are removed");
}

#[test]
fn adjacent_identical_emoji_do_not_confuse_the_boundary() {
    let current = "😀😀";
    let replacement = "😀🙂😀";
    let result = splice(current, replacement);

    assert_eq!(apply(current, &result), replacement);
    assert!(
        String::from_utf16(&result.insert.encode_utf16().collect::<Vec<_>>()).is_ok(),
        "the inserted text is well-formed"
    );
}

#[test]
fn the_golden_fixture_note_round_trips() {
    let current = "A😀<A><B>B!";
    for replacement in [
        "A😀<A><B>B!.",
        "A😀<A><B>B",
        "A😀<A><C>B!",
        "A🙂<A><B>B!",
        "",
        "completely different",
    ] {
        let Some(result) = TextSplice::between(current, replacement) else {
            continue;
        };
        assert_eq!(
            apply(current, &result),
            replacement,
            "splice must reproduce {replacement:?}",
        );
    }
}
