use std::collections::hash_map::DefaultHasher;
use std::fs::{self, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::json;

use crate::domains::context_compile::runtime::CompileFoundationMode;

use super::super::native_common::now_iso;
use super::super::native_tools::NativeToolContext;

static FOUNDATION_TELEMETRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub(super) struct FoundationTelemetryInput<'a> {
    pub(super) run_id: &'a str,
    pub(super) mode: CompileFoundationMode,
    pub(super) queue_wait: Duration,
    pub(super) work_duration: Duration,
    pub(super) total_duration: Duration,
    pub(super) error: Option<&'a str>,
    pub(super) pre_ledger_total: Duration,
}

pub(super) fn append_foundation_telemetry(
    context: &NativeToolContext,
    input: FoundationTelemetryInput<'_>,
) {
    let directory = context
        .compile_runtime
        .logs_dir
        .join("context-compile-foundation");
    let lock = FOUNDATION_TELEMETRY_LOCK.get_or_init(|| Mutex::new(()));
    let Ok(_guard) = lock.lock() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let path = directory.join(format!(
        "{}.{}.jsonl",
        &context.compile_runtime.runtime_build_id[..16],
        std::process::id()
    ));
    let record = json!({
        "contractVersion": 1,
        "runId": input.run_id,
        "recordedAt": now_iso(),
        "pipelineVersion": "foundation-v1",
        "pipelineMode": input.mode.as_str(),
        "runtimeVersion": crate::VERSION,
        "runtimeBuildId": context.compile_runtime.runtime_build_id,
        "databaseIdentityFingerprint": context.compile_runtime.database_identity_fingerprint,
        "writer": {
            "operation": if input.mode == CompileFoundationMode::Legacy { "mcp.context_compile" } else { "mcp.context_compile.persist" },
            "queueWaitUs": input.queue_wait.as_micros().min(u64::MAX as u128) as u64,
            "workUs": input.work_duration.as_micros().min(u64::MAX as u128) as u64,
            "totalUs": input.total_duration.as_micros().min(u64::MAX as u128) as u64,
            "success": input.error.is_none(),
            "errorCategory": input.error.map(|_| "writer_error")
        },
        "preLedgerEndToEndUs": input.pre_ledger_total.as_micros().min(u64::MAX as u128) as u64
    });
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let Ok(line) = serde_json::to_vec(&record) else {
        return;
    };
    if line.len() > 16 * 1024 {
        return;
    }
    let _ = file.write_all(&line);
    let _ = file.write_all(b"\n");
    let _ = file.flush();
}

pub(super) fn goal_hash(goal: &str) -> String {
    let mut hasher = DefaultHasher::new();
    goal.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}
