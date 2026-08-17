use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use reqwest::blocking::Client;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{
    domains::{
        bootstrap::service::resolve_paths,
        cli::routing::ContextCompileAction,
        runtime_identity::{self, EffectiveDatabaseIdentity},
    },
    shared::{config::EnvProvider, errors::CliError, process::ProcessSupervisor},
    VERSION,
};

use super::{
    runtime::CompileFoundationMode,
    timestamp::{format_unix_ms, parse_unix_ms, sqlite_timestamp_millis_expression},
};

const CONTRACT_VERSION: u8 = 1;
const PIPELINE_VERSION: &str = "foundation-v1";

pub fn run<E: EnvProvider, S: ProcessSupervisor>(
    action: ContextCompileAction,
    env: &E,
    supervisor: &S,
) -> Result<Value, CliError> {
    let identity = runtime_identity::resolve(env, supervisor);
    if identity.mismatch {
        return Err(CliError::runtime(
            "database identity mismatch: explicit configuration and live resident state disagree",
        ));
    }
    let mode = CompileFoundationMode::from_env(env).map_err(CliError::invalid_arguments)?;
    let paths = resolve_paths(env);
    match action {
        ContextCompileAction::Capabilities { out } => {
            let report = capabilities_report(&identity, mode, &paths.backup_dir);
            write_optional_report(out.as_deref(), &report)?;
            Ok(report)
        }
        ContextCompileAction::Baseline {
            manifest,
            out,
            probe,
        } => {
            let manifest = load_manifest(&manifest)?;
            let report = baseline_report(&manifest, &identity, mode, probe.as_deref())?;
            write_report(&out, &report)?;
            Ok(report)
        }
        ContextCompileAction::Compare {
            manifest,
            baseline,
            candidate,
            out,
        } => {
            let manifest = load_manifest(&manifest)?;
            let report = compare_report(&manifest, &identity, mode, &baseline, &candidate)?;
            write_report(&out, &report)?;
            Ok(report)
        }
        ContextCompileAction::Experiment {
            manifest,
            out,
            allow_provider_calls,
        } => {
            if !allow_provider_calls {
                return Err(CliError::invalid_arguments(
                    "experiment requires the exact --allow-provider-calls flag",
                ));
            }
            let manifest = load_manifest(&manifest)?;
            let report = experiment_report(&manifest, &identity, mode)?;
            write_report(&out, &report)?;
            Ok(report)
        }
        ContextCompileAction::Probe {
            manifest,
            entry_report,
            out,
            calls,
            allow_live_writes,
        } => {
            if !allow_live_writes {
                return Err(CliError::invalid_arguments(
                    "probe requires the exact --allow-live-writes flag",
                ));
            }
            let manifest = load_manifest(&manifest)?;
            let report = probe_report(&manifest, &identity, mode, &entry_report, calls, env)?;
            write_report(&out, &report)?;
            Ok(report)
        }
    }
}

pub fn summary(report: &Value) -> String {
    let kind = report
        .get("reportKind")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let eligible = report
        .get("promotionEligible")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let included = report
        .pointer("/cohort/included")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    format!("reportKind={kind}\npromotionEligible={eligible}\ncohortIncluded={included}")
}

#[derive(Debug, Clone)]
struct Manifest {
    id: String,
    pipeline_version: String,
    sha256: String,
    hard_query_set: PathBuf,
    golden_fixture: PathBuf,
    fixture_hashes: BTreeMap<String, String>,
}

fn load_manifest(path: &Path) -> Result<Manifest, CliError> {
    let bytes = fs::read(path)
        .map_err(|error| CliError::io(format!("failed to read Foundation manifest: {error}")))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::invalid_arguments(format!("invalid Foundation manifest JSON: {error}"))
    })?;
    let object = value
        .as_object()
        .ok_or_else(|| CliError::invalid_arguments("Foundation manifest must be a JSON object"))?;
    const ROOT_FIELDS: &[&str] = &[
        "id",
        "pipelineVersion",
        "inputs",
        "runtimeBinding",
        "cohorts",
        "performance",
        "availability",
        "ranking",
        "telemetry",
        "statistics",
        "safety",
        "stopConditions",
    ];
    if let Some(unknown) = object
        .keys()
        .find(|key| !ROOT_FIELDS.contains(&key.as_str()))
    {
        return Err(CliError::invalid_arguments(format!(
            "unknown Foundation manifest field: {unknown}"
        )));
    }
    let id = required_manifest_string(object, "id")?;
    let pipeline_version = required_manifest_string(object, "pipelineVersion")?;
    if pipeline_version != PIPELINE_VERSION {
        return Err(CliError::invalid_arguments(format!(
            "unsupported Foundation pipelineVersion: {pipeline_version}"
        )));
    }
    for field in [
        "runtimeBinding",
        "cohorts",
        "performance",
        "availability",
        "ranking",
        "telemetry",
        "statistics",
        "safety",
        "stopConditions",
    ] {
        if !object.contains_key(field) {
            return Err(CliError::invalid_arguments(format!(
                "Foundation manifest is missing {field}"
            )));
        }
    }
    let inputs = required_manifest_object(object, "inputs")?;
    ensure_exact_fields(
        inputs,
        "Foundation manifest inputs",
        &["hardQuerySet", "goldenFixture", "timestampFixture"],
    )?;
    let runtime_binding = required_manifest_object(object, "runtimeBinding")?;
    ensure_exact_fields(
        runtime_binding,
        "Foundation manifest runtimeBinding",
        &[
            "sourceCommitRequired",
            "runtimeBuildIdRequired",
            "effectiveDatabaseFingerprintRequired",
            "cleanSourceTreeRequiredForPromotion",
        ],
    )?;
    for field in runtime_binding.keys() {
        if runtime_binding
            .get(field)
            .and_then(Value::as_bool)
            .is_none()
        {
            return Err(CliError::invalid_arguments(format!(
                "Foundation manifest runtimeBinding.{field} must be a boolean"
            )));
        }
    }
    let cohorts = required_manifest_object(object, "cohorts")?;
    for field in [
        "historicalIdentityPresentMin",
        "retrievalFixtureRuns",
        "rankingHardQueriesMin",
        "compositionQueriesMinPerRoute",
        "liveBaselineProbeMin",
        "shadowIdentityPresentMin",
        "canaryIdentityPresentMin",
        "canaryWindowHours",
    ] {
        if cohorts
            .get(field)
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .is_none()
        {
            return Err(CliError::invalid_arguments(format!(
                "Foundation manifest cohorts.{field} must be a positive integer"
            )));
        }
    }
    for field in [
        "performance",
        "availability",
        "ranking",
        "telemetry",
        "statistics",
        "safety",
    ] {
        required_manifest_object(object, field)?;
    }
    let stop_conditions = object
        .get("stopConditions")
        .and_then(Value::as_array)
        .filter(|conditions| !conditions.is_empty())
        .ok_or_else(|| {
            CliError::invalid_arguments(
                "Foundation manifest stopConditions must be a non-empty array",
            )
        })?;
    if stop_conditions.iter().any(|condition| {
        condition
            .as_str()
            .is_none_or(|condition| condition.trim().is_empty())
    }) {
        return Err(CliError::invalid_arguments(
            "Foundation manifest stopConditions must contain only non-empty strings",
        ));
    }
    let manifest_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let hard_query_set = resolve_manifest_input(manifest_dir, inputs, "hardQuerySet")?;
    let golden_fixture = resolve_manifest_input(manifest_dir, inputs, "goldenFixture")?;
    let timestamp_fixture = resolve_manifest_input(manifest_dir, inputs, "timestampFixture")?;
    let mut fixture_hashes = BTreeMap::new();
    for (name, input) in [
        ("hardQuerySet", &hard_query_set),
        ("goldenFixture", &golden_fixture),
        ("timestampFixture", &timestamp_fixture),
    ] {
        let bytes = fs::read(input).map_err(|error| {
            CliError::io(format!("failed to read Foundation {name} fixture: {error}"))
        })?;
        fixture_hashes.insert(name.to_string(), sha256_hex(&bytes));
    }
    Ok(Manifest {
        id,
        pipeline_version,
        sha256: sha256_hex(&bytes),
        hard_query_set,
        golden_fixture,
        fixture_hashes,
    })
}

fn required_manifest_string(
    object: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<String, CliError> {
    object
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| CliError::invalid_arguments(format!("Foundation manifest requires {name}")))
}

fn required_manifest_object<'a>(
    object: &'a serde_json::Map<String, Value>,
    name: &str,
) -> Result<&'a serde_json::Map<String, Value>, CliError> {
    object.get(name).and_then(Value::as_object).ok_or_else(|| {
        CliError::invalid_arguments(format!("Foundation manifest {name} must be an object"))
    })
}

fn ensure_exact_fields(
    object: &serde_json::Map<String, Value>,
    object_name: &str,
    expected: &[&str],
) -> Result<(), CliError> {
    if object.len() != expected.len() || object.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(CliError::invalid_arguments(format!(
            "{object_name} contains missing or unknown fields"
        )));
    }
    Ok(())
}

fn resolve_manifest_input(
    manifest_dir: &Path,
    inputs: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<PathBuf, CliError> {
    let raw = inputs
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            CliError::invalid_arguments(format!("Foundation manifest inputs requires {name}"))
        })?;
    Ok(manifest_dir.join(raw))
}

fn capabilities_report(
    identity: &EffectiveDatabaseIdentity,
    mode: CompileFoundationMode,
    backup_dir: &Path,
) -> Value {
    let live_entry_eligible = identity.effective_path.is_file()
        && matches!(
            mode,
            CompileFoundationMode::SplitLegacyRank
                | CompileFoundationMode::SplitShadowRank
                | CompileFoundationMode::Foundation
        );
    json!({
        "contractVersion": CONTRACT_VERSION,
        "reportKind": "capabilities",
        "generatedAt": now_timestamp(),
        "ownershipRows": [
            {"surfaceId": "mcp.context_compile", "entryPoint": "rust-native MCP", "semanticOwner": "rust", "foundationSemantics": "active", "maintained": true},
            {"surfaceId": "ts.context_compiler", "entryPoint": "TypeScript repository/compiler", "semanticOwner": "typescript", "foundationSemantics": "legacy_unmigrated", "maintained": true},
            {"surfaceId": "sqlite_writer", "entryPoint": "rust sqlite writer", "semanticOwner": "rust", "foundationSemantics": "active", "maintained": true}
        ],
        "entryDecisions": {
            "scaffoldEntryEligible": true,
            "foundationCodeEntryEligible": true,
            "liveEntryEligible": live_entry_eligible,
            "predicates": {
                "runtimeIdentityAvailable": !identity.fingerprint.is_empty(),
                "runtimeBuildIdAvailable": !runtime_identity::build_id().is_empty(),
                "modeImplemented": true,
                "databaseIdentityMismatch": identity.mismatch,
                "databaseExists": identity.effective_path.is_file(),
                "modeSupportsLiveProbe": mode != CompileFoundationMode::Legacy
            }
        },
        "runtime": {
            "version": VERSION,
            "buildId": runtime_identity::build_id(),
            "pipelineMode": mode.as_str(),
            "effectiveDatabaseIdentitySource": identity.source,
            "effectiveDatabaseFingerprint": identity.fingerprint,
            "backupFingerprint": runtime_identity::service::fingerprint(backup_dir)
        },
        "promotionEligible": false
    })
}

fn baseline_report(
    manifest: &Manifest,
    identity: &EffectiveDatabaseIdentity,
    mode: CompileFoundationMode,
    probe: Option<&Path>,
) -> Result<Value, CliError> {
    let historical = historical_cohort(&identity.effective_path)?;
    let fixture_cases = fixture_case_count(&manifest.golden_fixture)?;
    let probe_summary = probe
        .map(|path| read_probe_summary(path, manifest, identity))
        .transpose()?;
    Ok(json!({
        "contractVersion": CONTRACT_VERSION,
        "reportKind": "baseline",
        "generatedAt": now_timestamp(),
        "manifest": {"id": manifest.id, "sha256": manifest.sha256},
        "binding": binding(manifest, identity, mode),
        "cohort": {
            "included": historical.included,
            "excluded": historical.excluded,
            "excludedByReason": historical.excluded_by_reason,
            "invalidTimestampCount": historical.invalid_timestamp_count
        },
        "cohorts": {
            "historicalReadOnly": historical.to_json(),
            "fixedFixture": {"cases": fixture_cases, "fixtureSha256": manifest.fixture_hashes.get("goldenFixture")}
        },
        "metrics": {
            "historicalRuns": historical.included,
            "foundationRuns": historical.foundation_runs,
            "pipelineModes": historical.pipeline_modes,
            "callerObserved": probe_summary
        },
        "safety": {"databaseIdentityMismatch": false, "wrongProject": 0, "unresolvedSelected": 0},
        "gateResults": [{"gate": "provisional_offline_only", "passed": false, "reason": "live probe and canary evidence are not supplied"}],
        "promotionEligible": false
    }))
}

#[derive(Default)]
struct HistoricalCohort {
    included: u64,
    excluded: u64,
    invalid_timestamp_count: u64,
    foundation_runs: u64,
    excluded_by_reason: BTreeMap<String, u64>,
    pipeline_modes: BTreeMap<String, u64>,
    table_available: bool,
    identity_column_available: bool,
}

impl HistoricalCohort {
    fn to_json(&self) -> Value {
        json!({
            "included": self.included,
            "excluded": self.excluded,
            "excludedByReason": self.excluded_by_reason,
            "invalidTimestampCount": self.invalid_timestamp_count,
            "tableAvailable": self.table_available,
            "identityColumnAvailable": self.identity_column_available
        })
    }
}

fn historical_cohort(path: &Path) -> Result<HistoricalCohort, CliError> {
    if !path.exists() {
        return Ok(HistoricalCohort {
            excluded: 1,
            excluded_by_reason: BTreeMap::from([("database_missing".to_string(), 1)]),
            ..HistoricalCohort::default()
        });
    }
    let connection =
        Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| {
            CliError::runtime(format!(
                "failed to open effective SQLite database read-only: {error}"
            ))
        })?;
    let table_available = connection
        .query_row(
            "select 1 from sqlite_master where type = 'table' and name = 'context_compile_runs'",
            [],
            |_| Ok(()),
        )
        .is_ok();
    if !table_available {
        return Ok(HistoricalCohort {
            table_available,
            excluded: 1,
            excluded_by_reason: BTreeMap::from([("context_compile_runs_missing".to_string(), 1)]),
            ..HistoricalCohort::default()
        });
    }
    let mut cohort = HistoricalCohort {
        table_available,
        ..HistoricalCohort::default()
    };
    cohort.identity_column_available =
        column_exists(&connection, "context_compile_runs", "match_basis")?;
    let match_basis_column = if cohort.identity_column_available {
        "match_basis"
    } else {
        "'none'"
    };
    let created_at_epoch_ms = sqlite_timestamp_millis_expression("created_at");
    let query = format!(
        "select created_at, pack_snapshot, {created_at_epoch_ms} as created_at_epoch_ms, {match_basis_column} as match_basis from context_compile_runs"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| CliError::runtime(format!("failed to query compile history: {error}")))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| {
            CliError::runtime(format!("failed to enumerate compile history: {error}"))
        })?;
    for row in rows {
        let (_created_at, pack_snapshot, created_at_epoch_ms, match_basis) =
            row.map_err(|error| {
                CliError::runtime(format!("failed to read compile history row: {error}"))
            })?;
        if created_at_epoch_ms.is_none() {
            cohort.invalid_timestamp_count += 1;
            cohort.excluded += 1;
            *cohort
                .excluded_by_reason
                .entry("invalid_timestamp".to_string())
                .or_default() += 1;
            continue;
        }
        if match_basis.as_deref().unwrap_or("none") == "none" {
            cohort.excluded += 1;
            *cohort
                .excluded_by_reason
                .entry("identity_missing".to_string())
                .or_default() += 1;
            continue;
        }
        cohort.included += 1;
        let Some(pack_snapshot) = pack_snapshot else {
            continue;
        };
        let Ok(pack) = serde_json::from_str::<Value>(&pack_snapshot) else {
            continue;
        };
        let Some(foundation) = pack.pointer("/diagnostics/foundation") else {
            continue;
        };
        cohort.foundation_runs += 1;
        if let Some(mode) = foundation.get("pipelineMode").and_then(Value::as_str) {
            *cohort.pipeline_modes.entry(mode.to_string()).or_default() += 1;
        }
    }
    Ok(cohort)
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, CliError> {
    let mut statement = connection
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|error| CliError::runtime(format!("failed to inspect {table} schema: {error}")))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| {
            CliError::runtime(format!("failed to inspect {table} columns: {error}"))
        })?;
    for name in columns {
        if name
            .map_err(|error| CliError::runtime(format!("failed to read {table} column: {error}")))?
            == column
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn fixture_case_count(path: &Path) -> Result<usize, CliError> {
    let bytes = fs::read(path)
        .map_err(|error| CliError::io(format!("failed to read golden fixture: {error}")))?;
    let fixture: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::invalid_arguments(format!("invalid golden fixture JSON: {error}"))
    })?;
    fixture
        .get("cases")
        .and_then(Value::as_array)
        .map(Vec::len)
        .ok_or_else(|| CliError::invalid_arguments("golden fixture requires cases[]"))
}

fn read_probe_summary(
    path: &Path,
    manifest: &Manifest,
    identity: &EffectiveDatabaseIdentity,
) -> Result<Value, CliError> {
    let bytes = fs::read(path)
        .map_err(|error| CliError::io(format!("failed to read probe report: {error}")))?;
    let report: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::invalid_arguments(format!("invalid probe report JSON: {error}"))
    })?;
    if report.get("reportKind").and_then(Value::as_str) != Some("live_probe") {
        return Err(CliError::invalid_arguments(
            "--probe must reference a live_probe report",
        ));
    }
    ensure_report_binding(&report, manifest, identity)?;
    Ok(json!({
        "requestedCalls": report.get("requestedCalls"),
        "completedCalls": report.get("completedCalls"),
        "metrics": report.get("metrics")
    }))
}

fn compare_report(
    manifest: &Manifest,
    identity: &EffectiveDatabaseIdentity,
    mode: CompileFoundationMode,
    baseline_path: &Path,
    candidate_path: &Path,
) -> Result<Value, CliError> {
    let baseline = read_report(baseline_path, "baseline")?;
    let candidate = read_report(candidate_path, "baseline")?;
    ensure_report_binding(&baseline, manifest, identity)?;
    ensure_report_binding(&candidate, manifest, identity)?;
    ensure_equivalent_compare_bindings(&baseline, &candidate)?;
    let baseline_runs = baseline
        .pointer("/metrics/historicalRuns")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let candidate_runs = candidate
        .pointer("/metrics/historicalRuns")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let delta = candidate_runs as i128 - baseline_runs as i128;
    let baseline_bytes = fs::read(baseline_path)
        .map_err(|error| CliError::io(format!("failed to read baseline report: {error}")))?;
    Ok(json!({
        "contractVersion": CONTRACT_VERSION,
        "reportKind": "compare",
        "generatedAt": now_timestamp(),
        "manifest": {"id": manifest.id, "sha256": manifest.sha256},
        "binding": binding(manifest, identity, mode),
        "baselineReportSha256": sha256_hex(&baseline_bytes),
        "baselineBinding": baseline.get("binding"),
        "candidateBinding": candidate.get("binding"),
        "cohort": {"included": candidate_runs, "excluded": 0, "excludedByReason": {}, "invalidTimestampCount": 0},
        "metrics": {"historicalRuns": {"baseline": baseline_runs, "candidate": candidate_runs, "absoluteDelta": delta, "relativeDelta": relative_delta(baseline_runs, candidate_runs)}},
        "pairedSampleCount": 0,
        "confidenceInterval": null,
        "gateResults": [{"gate": "paired_live_evidence", "passed": false, "reason": "offline baseline reports are not paired live probes"}],
        "promotionEligible": false
    }))
}

fn read_report(path: &Path, expected_kind: &str) -> Result<Value, CliError> {
    let bytes =
        fs::read(path).map_err(|error| CliError::io(format!("failed to read report: {error}")))?;
    let report: Value = serde_json::from_slice(&bytes)
        .map_err(|error| CliError::invalid_arguments(format!("invalid report JSON: {error}")))?;
    if report.get("reportKind").and_then(Value::as_str) != Some(expected_kind) {
        return Err(CliError::invalid_arguments(format!(
            "report must have reportKind={expected_kind}"
        )));
    }
    Ok(report)
}

fn ensure_report_binding(
    report: &Value,
    manifest: &Manifest,
    identity: &EffectiveDatabaseIdentity,
) -> Result<(), CliError> {
    if report.get("contractVersion").and_then(Value::as_u64) != Some(CONTRACT_VERSION.into()) {
        return Err(CliError::invalid_arguments(
            "report contractVersion is not supported",
        ));
    }
    if report.pointer("/manifest/id").and_then(Value::as_str) != Some(manifest.id.as_str()) {
        return Err(CliError::invalid_arguments(
            "report manifest ID does not match --manifest",
        ));
    }
    if report.pointer("/manifest/sha256").and_then(Value::as_str) != Some(manifest.sha256.as_str())
    {
        return Err(CliError::invalid_arguments(
            "report manifest SHA-256 does not match --manifest",
        ));
    }
    if report
        .pointer("/binding/runtimeBuildId")
        .and_then(Value::as_str)
        != Some(runtime_identity::build_id().as_str())
    {
        return Err(CliError::invalid_arguments(
            "report runtime build ID does not match the running binary",
        ));
    }
    if report
        .pointer("/binding/runtimeVersion")
        .and_then(Value::as_str)
        != Some(VERSION)
    {
        return Err(CliError::invalid_arguments(
            "report runtime version does not match the running binary",
        ));
    }
    if report
        .pointer("/binding/pipelineVersion")
        .and_then(Value::as_str)
        != Some(manifest.pipeline_version.as_str())
    {
        return Err(CliError::invalid_arguments(
            "report pipeline version does not match --manifest",
        ));
    }
    if report
        .pointer("/binding/effectiveDatabaseFingerprint")
        .and_then(Value::as_str)
        != Some(identity.fingerprint.as_str())
    {
        return Err(CliError::invalid_arguments(
            "report database fingerprint does not match current effective database",
        ));
    }
    let expected_fixtures = serde_json::to_value(&manifest.fixture_hashes)
        .map_err(|error| CliError::runtime(format!("failed to encode fixture binding: {error}")))?;
    if report.pointer("/binding/fixtureSha256") != Some(&expected_fixtures) {
        return Err(CliError::invalid_arguments(
            "report fixture hashes do not match --manifest",
        ));
    }
    Ok(())
}

fn ensure_equivalent_compare_bindings(baseline: &Value, candidate: &Value) -> Result<(), CliError> {
    for pointer in [
        "/binding/sourceCommit",
        "/binding/sourceTreeState",
        "/binding/runtimeVersion",
        "/binding/runtimeBuildId",
        "/binding/pipelineVersion",
        "/binding/effectiveDatabaseFingerprint",
        "/binding/fixtureSha256",
    ] {
        if baseline.pointer(pointer) != candidate.pointer(pointer) {
            return Err(CliError::invalid_arguments(format!(
                "baseline and candidate report bindings differ at {pointer}",
            )));
        }
    }
    Ok(())
}

fn experiment_report(
    manifest: &Manifest,
    identity: &EffectiveDatabaseIdentity,
    mode: CompileFoundationMode,
) -> Result<Value, CliError> {
    let bytes = fs::read(&manifest.hard_query_set)
        .map_err(|error| CliError::io(format!("failed to read hard query set: {error}")))?;
    let query_set: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::invalid_arguments(format!("invalid hard query set JSON: {error}"))
    })?;
    let queries = query_set
        .get("queries")
        .and_then(Value::as_array)
        .ok_or_else(|| CliError::invalid_arguments("hard query set requires queries[]"))?;
    let results = queries
        .iter()
        .map(|query| {
            let query_id = query.get("id").and_then(Value::as_str).unwrap_or("invalid");
            json!({
                "queryId": query_id,
                "route": "current_two_call",
                "preparedSnapshotSha256": sha256_hex(query_id.as_bytes()),
                "outputSha256": null,
                "selectedIds": [],
                "usedIds": [],
                "logicalCalls": 0,
                "providerAttempts": 0,
                "failovers": 0,
                "latencyUs": null,
                "errorCategory": "route_not_enabled"
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "contractVersion": CONTRACT_VERSION,
        "reportKind": "composition_experiment",
        "generatedAt": now_timestamp(),
        "manifest": {"id": manifest.id, "sha256": manifest.sha256},
        "binding": binding(manifest, identity, mode),
        "providerCallsAllowed": true,
        "providerCallsExecuted": 0,
        "results": results,
        "promotionEligible": false
    }))
}

fn probe_report<E: EnvProvider>(
    manifest: &Manifest,
    identity: &EffectiveDatabaseIdentity,
    mode: CompileFoundationMode,
    entry_report_path: &Path,
    calls: usize,
    env: &E,
) -> Result<Value, CliError> {
    let entry = read_report(entry_report_path, "capabilities")?;
    if entry
        .pointer("/entryDecisions/liveEntryEligible")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(CliError::runtime(
            "probe requires a capabilities report with liveEntryEligible=true",
        ));
    }
    if entry.pointer("/runtime/buildId").and_then(Value::as_str)
        != Some(runtime_identity::build_id().as_str())
        || entry
            .pointer("/runtime/effectiveDatabaseFingerprint")
            .and_then(Value::as_str)
            != Some(identity.fingerprint.as_str())
        || entry
            .pointer("/runtime/pipelineMode")
            .and_then(Value::as_str)
            != Some(mode.as_str())
    {
        return Err(CliError::runtime(
            "probe entry report does not match current runtime identity/build/mode",
        ));
    }
    let generated_at = entry
        .get("generatedAt")
        .and_then(Value::as_str)
        .and_then(parse_unix_ms)
        .ok_or_else(|| {
            CliError::runtime("probe entry report has an invalid generatedAt timestamp")
        })?;
    if now_ms().saturating_sub(generated_at as u64) > 10 * 60 * 1000 {
        return Err(CliError::runtime(
            "probe entry report is older than 10 minutes",
        ));
    }
    let endpoint = crate::domains::mcp_lifecycle::configured_endpoint_url(env)?;
    let client = Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| {
            CliError::runtime(format!("failed to construct probe HTTP client: {error}"))
        })?;
    let queries = load_hard_queries(&manifest.hard_query_set)?;
    let probe_id = &sha256_hex(now_timestamp().as_bytes())[..12];
    let mut observations = Vec::with_capacity(calls);
    let mut successful_latencies = Vec::new();
    for ordinal in 0..calls {
        let query = &queries[ordinal % queries.len()];
        let session_id = match initialize_probe_session(&client, &endpoint) {
            Ok(session_id) => session_id,
            Err(error) => {
                observations.push(json!({
                    "ordinal": ordinal + 1,
                    "result": "transport_error",
                    "errorCategory": bounded_error_category(&error),
                    "callerObservedEndToEndUs": null,
                    "joinedRunId": null
                }));
                continue;
            }
        };
        let started = Instant::now();
        let response = client
            .post(&endpoint)
            .header("mcp-session-id", &session_id)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": ordinal + 1,
                "method": "tools/call",
                "params": {
                    "name": "context_compile",
                    "arguments": {
                        "goal": query.goal,
                        "technologies": query.technologies,
                        "changeTypes": query.change_types,
                        "domains": query.domains
                    }
                }
            }))
            .send();
        let elapsed_us = started.elapsed().as_micros().min(u64::MAX as u128) as u64;
        let observation = match response {
            Ok(response) if response.status().is_success() => match response.json::<Value>() {
                Ok(body)
                    if body.pointer("/result/isError").and_then(Value::as_bool) != Some(true) =>
                {
                    successful_latencies.push(elapsed_us);
                    json!({
                        "ordinal": ordinal + 1,
                        "result": "ok",
                        "errorCategory": null,
                        "callerObservedEndToEndUs": elapsed_us,
                        "joinedRunId": null
                    })
                }
                Ok(_) => json!({
                    "ordinal": ordinal + 1,
                    "result": "tool_error",
                    "errorCategory": "tool_error",
                    "callerObservedEndToEndUs": elapsed_us,
                    "joinedRunId": null
                }),
                Err(_) => json!({
                    "ordinal": ordinal + 1,
                    "result": "protocol_error",
                    "errorCategory": "invalid_json_response",
                    "callerObservedEndToEndUs": elapsed_us,
                    "joinedRunId": null
                }),
            },
            Ok(response) => json!({
                "ordinal": ordinal + 1,
                "result": "transport_error",
                "errorCategory": format!("http_{}", response.status().as_u16()),
                "callerObservedEndToEndUs": elapsed_us,
                "joinedRunId": null
            }),
            Err(error) => json!({
                "ordinal": ordinal + 1,
                "result": "transport_error",
                "errorCategory": bounded_error_category(&error.to_string()),
                "callerObservedEndToEndUs": elapsed_us,
                "joinedRunId": null
            }),
        };
        let _ = client
            .delete(&endpoint)
            .header("mcp-session-id", session_id)
            .send();
        observations.push(observation);
    }
    let completed_calls = observations
        .iter()
        .filter(|observation| observation.get("result").and_then(Value::as_str) == Some("ok"))
        .count();
    Ok(json!({
        "contractVersion": CONTRACT_VERSION,
        "reportKind": "live_probe",
        "generatedAt": now_timestamp(),
        "manifest": {"id": manifest.id, "sha256": manifest.sha256},
        "binding": binding(manifest, identity, mode),
        "requestedCalls": calls,
        "completedCalls": completed_calls,
        "sessionPrefix": format!("foundation-probe-{probe_id}"),
        "observations": observations,
        "metrics": {
            "callerObservedEndToEndUs": percentile_metrics(&successful_latencies),
            "availability": {"successRate": (completed_calls as f64) / (calls as f64)}
        },
        "promotionEligible": false
    }))
}

struct HardQuery {
    goal: String,
    technologies: Vec<String>,
    change_types: Vec<String>,
    domains: Vec<String>,
}

fn load_hard_queries(path: &Path) -> Result<Vec<HardQuery>, CliError> {
    let bytes = fs::read(path)
        .map_err(|error| CliError::io(format!("failed to read hard query set: {error}")))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        CliError::invalid_arguments(format!("invalid hard query set JSON: {error}"))
    })?;
    let queries = value
        .get("queries")
        .and_then(Value::as_array)
        .filter(|queries| !queries.is_empty())
        .ok_or_else(|| {
            CliError::invalid_arguments("hard query set requires a non-empty queries[]")
        })?;
    queries
        .iter()
        .map(|query| {
            let goal = query
                .get("goal")
                .and_then(Value::as_str)
                .filter(|goal| !goal.is_empty())
                .ok_or_else(|| {
                    CliError::invalid_arguments("each hard query requires a non-empty goal")
                })?;
            Ok(HardQuery {
                goal: goal.to_string(),
                technologies: json_string_array(query, "technologies"),
                change_types: json_string_array(query, "changeTypes"),
                domains: json_string_array(query, "domains"),
            })
        })
        .collect()
}

fn json_string_array(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn initialize_probe_session(client: &Client, endpoint: &str) -> Result<String, String> {
    let response = client
        .post(endpoint)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "clientInfo": {"name": "foundation-probe", "version": "1"}}
        }))
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("http_{}", response.status().as_u16()));
    }
    response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "initialize_session_missing".to_string())
}

fn bounded_error_category(error: &str) -> &'static str {
    if error.contains("timed out") {
        "timeout"
    } else if error.contains("connection") {
        "connection"
    } else {
        "transport"
    }
}

fn percentile_metrics(values: &[u64]) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    let mut values = values.to_vec();
    values.sort_unstable();
    let rank = |percentile: f64| {
        values[((percentile * values.len() as f64).ceil() as usize).saturating_sub(1)]
    };
    json!({"p50Us": rank(0.50), "p95Us": rank(0.95)})
}

fn binding(
    manifest: &Manifest,
    identity: &EffectiveDatabaseIdentity,
    mode: CompileFoundationMode,
) -> Value {
    json!({
        "sourceCommit": option_env!("GIT_COMMIT").unwrap_or("unavailable"),
        "sourceTreeState": "unknown",
        "runtimeVersion": VERSION,
        "runtimeBuildId": runtime_identity::build_id(),
        "pipelineVersion": manifest.pipeline_version,
        "pipelineMode": mode.as_str(),
        "effectiveDatabaseFingerprint": identity.fingerprint,
        "effectiveDatabaseIdentitySource": identity.source,
        "fixtureSha256": manifest.fixture_hashes
    })
}

fn relative_delta(baseline: u64, candidate: u64) -> Option<f64> {
    (baseline > 0).then(|| (candidate as f64 - baseline as f64) / baseline as f64)
}

fn write_optional_report(path: Option<&Path>, report: &Value) -> Result<(), CliError> {
    if let Some(path) = path {
        write_report(path, report)?;
    }
    Ok(())
}

fn write_report(path: &Path, report: &Value) -> Result<(), CliError> {
    if path.exists() {
        return Err(CliError::invalid_arguments("--out must name a new file"));
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.exists() {
        return Err(CliError::invalid_arguments(
            "--out parent directory does not exist",
        ));
    }
    let stem = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("report.json");
    let temporary = parent.join(format!(".{stem}.{}.tmp", std::process::id()));
    if temporary.exists() {
        return Err(CliError::io(
            "Foundation report temporary file already exists",
        ));
    }
    let write_result = (|| -> Result<(), CliError> {
        let bytes = serde_json::to_vec_pretty(report)
            .map_err(|error| CliError::runtime(format!("failed to serialize report: {error}")))?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                CliError::io(format!("failed to create report temporary file: {error}"))
            })?;
        file.write_all(&bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.flush())
            .and_then(|_| file.sync_all())
            .map_err(|error| CliError::io(format!("failed to write Foundation report: {error}")))?;
        fs::rename(&temporary, path).map_err(|error| {
            CliError::io(format!(
                "failed to atomically publish Foundation report: {error}"
            ))
        })?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn now_timestamp() -> String {
    format_unix_ms(i64::try_from(now_ms()).unwrap_or(i64::MAX))
        .expect("current unix timestamp must be in the Foundation timestamp range")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_delta_is_null_without_a_baseline() {
        assert_eq!(relative_delta(0, 10), None);
        assert_eq!(relative_delta(10, 12), Some(0.2));
    }

    #[test]
    fn manifest_rejects_unknown_root_fields() {
        let directory = std::env::temp_dir().join(format!(
            "context_still_foundation_manifest_{}_{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("manifest.json");
        fs::write(
            &path,
            r#"{"id":"x","pipelineVersion":"foundation-v1","unknown":true}"#,
        )
        .unwrap();
        assert!(load_manifest(&path).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn historical_cohort_normalizes_sqlite_timestamps_and_requires_identity() {
        let path = std::env::temp_dir().join(format!(
            "context_still_foundation_historical_{}_{}.sqlite",
            std::process::id(),
            now_ms()
        ));
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r#"
                create table context_compile_runs (
                  created_at text,
                  pack_snapshot text,
                  match_basis text
                );
                insert into context_compile_runs values
                  ('unix-ms:1700000000000', '{"diagnostics":{"foundation":{"pipelineMode":"foundation"}}}', 'project_ref'),
                  ('2026-08-17 00:00:00', null, 'repo_key'),
                  ('not-a-timestamp', null, 'project_ref'),
                  ('2026-08-17T00:00:00Z', null, 'none');
                "#,
            )
            .unwrap();
        drop(connection);

        let cohort = historical_cohort(&path).unwrap();
        assert_eq!(cohort.included, 2);
        assert_eq!(cohort.excluded, 2);
        assert_eq!(cohort.invalid_timestamp_count, 1);
        assert_eq!(cohort.foundation_runs, 1);
        assert_eq!(cohort.excluded_by_reason["invalid_timestamp"], 1);
        assert_eq!(cohort.excluded_by_reason["identity_missing"], 1);
        assert!(cohort.identity_column_available);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn compare_binding_rejects_runtime_and_fixture_mismatches() {
        let manifest = Manifest {
            id: "fixture".to_string(),
            pipeline_version: PIPELINE_VERSION.to_string(),
            sha256: "manifest-sha".to_string(),
            hard_query_set: PathBuf::new(),
            golden_fixture: PathBuf::new(),
            fixture_hashes: BTreeMap::from([(
                "goldenFixture".to_string(),
                "fixture-sha".to_string(),
            )]),
        };
        let identity = EffectiveDatabaseIdentity {
            configured_path: PathBuf::from("configured.sqlite"),
            resident_path: None,
            effective_path: PathBuf::from("effective.sqlite"),
            source: crate::domains::runtime_identity::DatabaseIdentitySource::AppDataDefault,
            resident_pid: None,
            resident_running: false,
            mismatch: false,
            fingerprint: "database-sha".to_string(),
        };
        let mut report = json!({
            "contractVersion": CONTRACT_VERSION,
            "reportKind": "baseline",
            "manifest": {"id": manifest.id, "sha256": manifest.sha256},
            "binding": {
                "runtimeBuildId": runtime_identity::build_id(),
                "runtimeVersion": VERSION,
                "pipelineVersion": PIPELINE_VERSION,
                "effectiveDatabaseFingerprint": identity.fingerprint,
                "fixtureSha256": manifest.fixture_hashes
            }
        });
        assert!(ensure_report_binding(&report, &manifest, &identity).is_ok());

        report["binding"]["runtimeBuildId"] = Value::String("other-build".to_string());
        assert!(ensure_report_binding(&report, &manifest, &identity).is_err());
        report["binding"]["runtimeBuildId"] = Value::String(runtime_identity::build_id());
        report["binding"]["fixtureSha256"] = json!({"goldenFixture": "other-fixture"});
        assert!(ensure_report_binding(&report, &manifest, &identity).is_err());
    }
}
