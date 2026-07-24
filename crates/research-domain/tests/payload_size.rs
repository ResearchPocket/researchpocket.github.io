//! Measures what one edit actually costs on the wire.
//!
//! Run with: cargo test -p research-domain --test payload_size -- --nocapture

use research_domain::{ItemSeed, Library};

const ITEM: &str = "0197f2b5-93d7-7ad4-8c67-21e98f0c7341";
const LIBRARY: &str = "00000000-0000-7000-8000-000000000001";
const DEVICE: &str = "00000000-0000-7000-8000-000000000002";

fn paragraph(words: usize) -> String {
    (0..words)
        .map(|index| format!("word{index:04}"))
        .collect::<Vec<_>>()
        .join(" ")
}

struct Measured {
    update: usize,
    envelope_json: usize,
}

/// Applies `edit` to a library seeded with `excerpt`/`note` and reports the
/// exported update size plus the serialized envelope size.
fn measure(excerpt: &str, note: &str, edit: impl FnOnce(&Library)) -> Measured {
    let library = Library::with_peer_id_for_fixture(101).expect("library");
    library
        .create_item(
            &ItemSeed {
                item_id: ITEM.to_owned(),
                url: "https://example.com/original".to_owned(),
                title: Some("Original".to_owned()),
                excerpt: Some(excerpt.to_owned()),
                favorite: false,
                language: Some(String::new()),
                saved_at: 1_700_000_000,
                note: note.to_owned(),
                tags: Vec::new(),
            },
            "device-base/00000000000000000001",
        )
        .expect("seed item");

    let before = library.version();
    edit(&library);
    let envelope = library
        .export_envelope(&before, LIBRARY, DEVICE, 2, "2026-07-25T00:00:00.000Z")
        .expect("envelope");
    let envelope_json = serde_json::to_string(&envelope).expect("serialize");

    Measured {
        // payload is base64 of the raw Loro update.
        update: envelope.payload.len() * 3 / 4,
        envelope_json: envelope_json.len(),
    }
}

#[test]
fn one_character_excerpt_edit_reports_its_true_cost() {
    let excerpt = paragraph(400);
    let edited = format!("{excerpt}.");
    println!(
        "\n--- excerpt: {} bytes, one character appended ---",
        excerpt.len()
    );

    let measured = measure(&excerpt, "", |library| {
        library
            .write_excerpt(ITEM, "device-a/00000000000000000002/excerpt", Some(&edited))
            .expect("write excerpt");
    });

    // Layer sizes on the way to GitHub.
    let packed = measured.envelope_json * 4 / 3; // envelope base64'd into a pack
    let uploaded = packed * 4 / 3; // pack base64'd into the Contents API body

    println!("loro update      : {:>7} bytes", measured.update);
    println!("envelope json    : {:>7} bytes", measured.envelope_json);
    println!("packed member    : {:>7} bytes", packed);
    println!("uploaded body    : {:>7} bytes", uploaded);
    println!(
        "amplification    : {:>7.1}x the edited excerpt",
        uploaded as f64 / edited.len() as f64
    );

    assert!(
        measured.update > excerpt.len(),
        "a scalar rewrite carries the whole excerpt: update {} vs excerpt {}",
        measured.update,
        excerpt.len()
    );
}

/// The regression guard for #115: the mutation path must not carry the whole
/// note. Compare against `a_full_range_splice_costs_the_whole_note` below.
#[test]
fn one_character_note_edit_sends_only_the_change() {
    let note = paragraph(400);
    let edited = format!("{note}.");
    println!(
        "\n--- note: {} bytes, one character appended ---",
        note.len()
    );

    let measured = measure("", &note, |library| {
        library.set_note(ITEM, &note, &edited).expect("set note");
    });

    println!("loro update      : {:>7} bytes", measured.update);
    println!("envelope json    : {:>7} bytes", measured.envelope_json);

    assert!(
        measured.update < note.len() / 4,
        "a minimal splice must not carry the whole note: update {} vs note {}",
        measured.update,
        note.len()
    );
}

/// Documents what the full-range splice used to cost, so the saving stays
/// visible if anyone reintroduces it.
#[test]
fn a_full_range_splice_costs_the_whole_note() {
    let note = paragraph(400);
    let edited = format!("{note}.");

    let measured = measure("", &note, |library| {
        library
            .splice_note_utf16(ITEM, 0, note.encode_utf16().count(), &edited)
            .expect("splice note");
    });

    println!(
        "\n--- full-range splice of a {} byte note: {} byte update ---",
        note.len(),
        measured.update
    );

    assert!(
        measured.update > note.len(),
        "the rejected approach carries the whole note: update {}",
        measured.update
    );
}

#[test]
fn a_minimal_note_splice_shows_the_available_headroom() {
    let note = paragraph(400);
    println!(
        "\n--- note: {} bytes, one character appended by tail splice ---",
        note.len()
    );

    let measured = measure("", &note, |library| {
        // Append at the end instead of replacing the whole range.
        let end = note.encode_utf16().count();
        library
            .splice_note_utf16(ITEM, end, 0, ".")
            .expect("splice note tail");
    });

    println!("loro update      : {:>7} bytes", measured.update);
    println!("envelope json    : {:>7} bytes", measured.envelope_json);

    assert!(
        measured.update < note.len() / 4,
        "a targeted splice must not carry the whole note: update {} vs note {}",
        measured.update,
        note.len()
    );
}

/// Superseded scalar revisions are retained forever, but they are near
/// duplicates and the snapshot encoding compresses them, so local storage
/// growth is modest. The cost of an edit is paid on the wire, not at rest.
#[test]
fn repeated_excerpt_edits_compress_well_at_rest() {
    let excerpt = paragraph(400);
    let library = Library::with_peer_id_for_fixture(101).expect("library");
    library
        .create_item(
            &ItemSeed {
                item_id: ITEM.to_owned(),
                url: "https://example.com/original".to_owned(),
                title: Some("Original".to_owned()),
                excerpt: Some(excerpt.clone()),
                favorite: false,
                language: Some(String::new()),
                saved_at: 1_700_000_000,
                note: String::new(),
                tags: Vec::new(),
            },
            "device-base/00000000000000000001",
        )
        .expect("seed item");

    let baseline = library.export_snapshot().expect("snapshot").len();
    for revision in 2..=21u64 {
        library
            .write_excerpt(
                ITEM,
                &format!("device-a/{revision:020}/excerpt"),
                Some(&format!("{excerpt} revision {revision}")),
            )
            .expect("write excerpt");
    }
    let after = library.export_snapshot().expect("snapshot").len();

    println!("\n--- 20 edits of a {} byte excerpt ---", excerpt.len());
    println!("snapshot before  : {:>7} bytes", baseline);
    println!("snapshot after   : {:>7} bytes", after);
    println!("growth per edit  : {:>7} bytes", (after - baseline) / 20);

    assert!(
        after - baseline < excerpt.len(),
        "20 retained revisions must still cost less than one excerpt at rest: grew {} bytes",
        after - baseline
    );
}
