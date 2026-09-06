use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::dataset::Task;

pub(super) fn grade(task: &Task, answer: &Value) -> (f64, bool) {
    let passed = task
        .checks
        .iter()
        .filter(|check| answer.pointer(&check.pointer) == Some(&check.equals))
        .count();
    let misleading = task
        .checks
        .iter()
        .any(|check| check.critical && answer.pointer(&check.pointer) != Some(&check.equals));
    (passed as f64 / task.checks.len() as f64, misleading)
}

pub(super) fn retrieval_metrics(task: &Task, ids: &[String]) -> Value {
    let hits = ids
        .iter()
        .enumerate()
        .filter(|(_, id)| task.expected_ids.contains(id))
        .collect::<Vec<_>>();
    let recall =
        (!task.expected_ids.is_empty()).then(|| hits.len() as f64 / task.expected_ids.len() as f64);
    let reciprocal_rank = (!task.expected_ids.is_empty())
        .then(|| hits.first().map_or(0.0, |(i, _)| 1.0 / (*i + 1) as f64));
    let ideal = (0..task.expected_ids.len().min(8))
        .map(|i| 1.0 / ((i + 2) as f64).log2())
        .sum::<f64>();
    let dcg = hits
        .iter()
        .map(|(i, _)| 1.0 / ((*i + 2) as f64).log2())
        .sum::<f64>();
    json!({"recallAt8": recall, "reciprocalRank": reciprocal_rank,
        "ndcgAt8": if ideal > 0.0 {Some(dcg / ideal)} else {None},
        "forbiddenHits": ids.iter().filter(|id| task.forbidden_ids.contains(id)).collect::<Vec<_>>()})
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

// Bootstrap task means, not repeated observations: repetitions are correlated.
fn paired_interval(values: &[f64]) -> Option<[f64; 2]> {
    if values.len() < 2 {
        return None;
    }
    let mut seed = 1337_u64;
    let mut samples = Vec::with_capacity(10_000);
    for _ in 0..10_000 {
        let mut sum = 0.0;
        for _ in values {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            sum += values[(seed % values.len() as u64) as usize];
        }
        samples.push(sum / values.len() as f64);
    }
    samples.sort_by(f64::total_cmp);
    Some([samples[249], samples[9749]])
}

pub(super) fn summarize(rows: &[Value]) -> Value {
    let mut conditions = BTreeMap::new();
    for name in ["no_memory", "legacy_memory", "foundation_memory"] {
        let selected = rows
            .iter()
            .filter(|row| row["condition"] == name)
            .collect::<Vec<_>>();
        let quality = selected
            .iter()
            .map(|r| r["quality"].as_f64().unwrap_or(0.0))
            .collect::<Vec<_>>();
        conditions.insert(name, json!({"observations": selected.len(),
            "completed": selected.iter().filter(|r| r["status"] == "completed").count(),
            "failedOrDegraded": selected.iter().filter(|r| r["status"] != "completed").count(),
            "meanQualityAllAttempts": mean(&quality),
            "criticalFailureCount": selected.iter().filter(|r| r["criticalFailure"] == true).count(),
            "meanLatencyMs": mean(&selected.iter().filter_map(|r| r["latencyMs"].as_f64()).collect::<Vec<_>>()),
            "providerCalls": selected.iter().filter_map(|r| r["providerCalls"].as_array()).map(Vec::len).sum::<usize>()}));
    }
    let mut comparisons = Vec::new();
    for candidate in ["legacy_memory", "foundation_memory"] {
        let mut by_task: BTreeMap<String, Vec<f64>> = BTreeMap::new();
        let mut complete = 0;
        for base in rows.iter().filter(|row| row["condition"] == "no_memory") {
            if let Some(other) = rows.iter().find(|r| {
                r["condition"] == candidate
                    && r["taskId"] == base["taskId"]
                    && r["repetition"] == base["repetition"]
            }) {
                if base["status"] == "completed" && other["status"] == "completed" {
                    complete += 1;
                }
                by_task
                    .entry(base["taskId"].as_str().unwrap_or_default().to_owned())
                    .or_default()
                    .push(
                        other["quality"].as_f64().unwrap_or(0.0)
                            - base["quality"].as_f64().unwrap_or(0.0),
                    );
            }
        }
        let deltas = by_task.values().filter_map(|v| mean(v)).collect::<Vec<_>>();
        comparisons.push(json!({"baseline": "no_memory", "candidate": candidate,
            "independentTasks": deltas.len(), "completePairs": complete,
            "meanQualityDeltaAllAttempts": mean(&deltas),
            "taskPairedBootstrap95": paired_interval(&deltas), "bootstrapSeed": 1337,
            "bootstrapIterations": 10000,
            "interpretation": "Exploratory regression-task decisions; not a coding-productivity or deployment gate"}));
    }
    json!({"conditions": conditions, "comparisons": comparisons})
}
