#![cfg(target_arch = "wasm32")]

use research_domain::{GOLDEN_CANONICAL_JSON, run_convergence_scenario};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn browser_wasm_executes_the_shared_convergence_scenario() {
    let actual = run_convergence_scenario().expect("WASM convergence scenario");
    assert_eq!(actual, GOLDEN_CANONICAL_JSON);
}
