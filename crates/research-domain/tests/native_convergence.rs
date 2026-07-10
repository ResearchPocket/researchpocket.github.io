use research_domain::{GOLDEN_CANONICAL_JSON, run_convergence_scenario};

#[test]
fn native_executes_the_shared_convergence_scenario() {
    let actual = run_convergence_scenario().expect("native convergence scenario");
    assert_eq!(actual, GOLDEN_CANONICAL_JSON);
}
