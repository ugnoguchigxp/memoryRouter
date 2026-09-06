"""Reproduce Finding boundaries using unchanged functions extracted from the workspace.

Run from any directory with python3. Uses a temporary Cargo project and in-memory SQLite.
No production database or provider is accessed. All secret-like values are synthetic.
"""
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
finding = (ROOT / "crates/context-stilld/src/domains/queue_lifecycle/finding_executor.rs").read_text()
store = (ROOT / "crates/context-stilld/src/domains/agent_log_sync/store.rs").read_text()


def extract(source, declaration):
    start = source.index(declaration)
    end = source.index("\n}", start) + 2
    return source[start:end]


parts = [
    "use serde::Deserialize; use serde_json::{json, Value};",
    "use rusqlite::{Connection, params}; use sha2::{Sha256, Digest};",
    "#[derive(Debug)] struct CliError(String); impl CliError { fn io(x: impl Into<String>) -> Self { Self(x.into()) } }",
    'const FINDING_VERSION: &str = "finding-candidate-rust-v1"; const MAX_CANDIDATES_PER_JOB: usize = 20;',
    "#[derive(Debug, Clone, Deserialize)]\n" + extract(finding, "pub(crate) struct Candidate {"),
    extract(finding, "struct FindingJob {"),
    extract(store, "struct FindingEligibility {"),
]
for name in ["parse_candidates", "has_skill_like_procedure_body", "filter_source_text", "truncate_middle", "persist_candidates", "stable_id"]:
    parts.append(extract(finding, f"fn {name}("))
for name in ["evaluate_finding_eligibility", "contains_any", "boilerplate_heavy", "progress_only"]:
    parts.append(extract(store, f"fn {name}("))

parts.append(r'''
fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let good = json!({"type":"rule","polarity":"positive","title":"Keep evidence","content":"Retain the validation evidence."});
    let invalid = json!({"type":"procedure","polarity":"negative","title":"Avoid deletion","content":"Do not delete queued jobs."});
    let mut over_cap = vec![invalid.clone(); 20]; over_cap.push(good.clone());
    let malformed_panics = std::panic::catch_unwind(|| parse_candidates("] explanation [")).is_err();
    let secret_fixture = "DATABASE_URL=postgres://review:synthetic-password@localhost/example\n{\"apiKey\":\"synthetic-review-value\"}\ncommand --token synthetic-review-token";
    let pref = format!("USER: {} 今後は必ず説明文を日本語にしてください。", "説明の対象は初めて画面を開く利用者です。".repeat(9));
    let status = format!("ASSISTANT: build succeeded. {}", "今回の実行が終了しました。".repeat(12));
    let short = "USER: 今後は必ずSQLiteの変更後にcargo testで検証してください。";
    let roles = json!({"roles":["user","assistant"]});
    let wrapped = format!("USER: <INSTRUCTIONS>\n{}\n</INSTRUCTIONS>\nASSISTANT: done", "Always preserve a synthetic instruction marker");
    let long_line = format!("{}MIDDLE_EVIDENCE{}", "a".repeat(2100), "b".repeat(2900));
    let long_source = format!("{}MIDDLE_EVIDENCE{}", "a".repeat(25000), "b".repeat(10000));
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch(r#"
      create table found_candidates (id text primary key, finding_job_id text, candidate_index integer, type text, title text, content text, source_summary text, origin text, metadata text, created_at text, updated_at text);
      create table covering_evidence_queue (id text primary key, found_candidate_id text, distillation_version text, status text, priority integer, provider_policy text, payload text, metadata text, created_at text, updated_at text);
    "#).unwrap();
    let job = FindingJob { id:"review-job".into(), input_kind:"source_target".into(), source_kind:"vibe_memory".into(), source_key:"review-memory".into(), source_uri:"vibe_memory:review-memory".into(), distillation_version:"v1".into(), priority:50, attempt_count:0, metadata:json!({}) };
    let first = parse_candidates(&json!([good.clone(), good.clone()]).to_string()).unwrap();
    persist_candidates(&connection, &job, &first).unwrap();
    connection.execute("update covering_evidence_queue set status='completed'", []).unwrap();
    let replacement = parse_candidates(r#"[{"type":"rule","polarity":"negative","title":"Changed candidate","content":"A different body after rerun."}]"#).unwrap();
    persist_candidates(&connection, &job, &replacement).unwrap();
    let candidate_count: i64 = connection.query_row("select count(*) from found_candidates", [], |r|r.get(0)).unwrap();
    let pending_count: i64 = connection.query_row("select count(*) from covering_evidence_queue where status='pending'", [], |r|r.get(0)).unwrap();
    let body: String = connection.query_row("select content from found_candidates where candidate_index=0", [], |r|r.get(0)).unwrap();
    let score = |s: &str| evaluate_finding_eligibility(s, &roles).map(|x| x.score);
    println!("{}", json!({
      "empty_object_accepted_count":parse_candidates("{}").unwrap().len(),
      "invalid_candidate_accepted_count":parse_candidates(&invalid.to_string()).unwrap().len(),
      "valid_candidate_after_20_invalid_accepted_count":parse_candidates(&json!(over_cap).to_string()).unwrap().len(),
      "malformed_bracket_order_panics":malformed_panics,
      "secret_fixture_unchanged":filter_source_text(secret_fixture)==secret_fixture,
      "role_prefixed_instructions_retained":filter_source_text(&wrapped).contains("synthetic instruction marker"),
      "single_line_middle_evidence_retained":filter_source_text(&long_line).contains("MIDDLE_EVIDENCE"),
      "whole_source_middle_evidence_retained":truncate_middle(&long_source, 32000).contains("MIDDLE_EVIDENCE"),
      "preference_eligible_score":score(&pref),
      "build_status_eligible_score":evaluate_finding_eligibility(&status,&json!({"roles":["assistant"]})).map(|x|x.score),
      "short_preference_eligible_score":score(short),
      "rerun":{"new_result_count":1,"persisted_candidate_count":candidate_count,"pending_covering_count":pending_count,"index_zero_body":body},
      "fixtures":{"preference":pref,"status":status,"short":short}
    }));
}
''')

with tempfile.TemporaryDirectory(prefix="finding-review-") as temp:
    project = pathlib.Path(temp)
    (project / "src").mkdir()
    (project / "src/main.rs").write_text("\n\n".join(parts))
    (project / "Cargo.toml").write_text('''[package]
name = "finding-review-probe"
version = "0.1.0"
edition = "2021"
[dependencies]
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
rusqlite = { version = "0.32", features = ["bundled", "functions", "hooks"] }
sha2 = "0.10"
''')
    result = subprocess.run(["cargo", "run", "--offline", "--quiet", "--manifest-path", str(project / "Cargo.toml"), "--target-dir", str(ROOT / "target")], text=True, capture_output=True, check=True)
    rust = json.loads(result.stdout)
    # Cross-check the exact same fixtures through the TypeScript eligibility implementation.
    module = str(ROOT / "src/modules/findCandidate/vibe-finding-eligibility.ts")
    js = f"import {{ evaluateVibeFindingEligibility as e }} from {json.dumps(module)};\n"
    js += "const fixtures = " + json.dumps(rust.pop("fixtures"), ensure_ascii=False) + ";\n"
    js += "console.log(JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([key,content]) => [key,e({id:key,sessionId:'review',content,metadata:{roles:key==='status'?['assistant']:['user','assistant']}})]))));"
    ts_result = subprocess.run(["bun", "--no-env-file", "-e", js], cwd=ROOT, text=True, capture_output=True, check=True)
    output = {"rust": rust, "typescript": json.loads(ts_result.stdout)}
    (HERE / "probe-results.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(output, ensure_ascii=False, indent=2))
