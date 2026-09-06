use std::collections::HashSet;

use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use super::types::{
    CanonicalEpisode, EpisodeScores, ValueReview, MIN_EPISODE_COMPRESSION_QUALITY,
    MIN_EPISODE_CONFIDENCE, MIN_EPISODE_EVIDENCE_QUALITY, MIN_EPISODE_IMPORTANCE,
    MIN_EPISODE_REUSABLE_SIGNAL, MIN_EPISODE_VALUE_SCORE,
};

pub(super) fn calibrate_episode(mut canonical: CanonicalEpisode) -> CanonicalEpisode {
    canonical.action_taken = canonical.action_taken.trim().to_string();
    canonical.failed_approach = canonical.failed_approach.trim().to_string();
    canonical.generation_kind = normalize_generation_kind(&canonical.generation_kind);
    canonical.outcome_kind = normalize_outcome_kind(&canonical.outcome_kind);
    canonical.scores = clamp_scores(canonical.scores);
    let small_change_signal = canonical.generation_kind == "task_episode"
        && canonical.scores.failure_value <= 10
        && canonical.scores.decision_density <= 70
        && canonical.scores.reusability <= 70;
    let value_score = quality_value_score(&canonical.scores);
    let mut importance_cap = 100.min(value_score + 10);
    if canonical.action_taken.is_empty() && canonical.failed_approach.is_empty() {
        importance_cap = importance_cap.min(65);
    }
    if small_change_signal {
        importance_cap = importance_cap.min(75);
    }
    canonical.scores.confidence = canonical.scores.confidence.min(80);
    canonical.scores.importance = canonical.scores.importance.min(importance_cap);
    canonical
}

pub(super) fn review_episode_value(canonical: &CanonicalEpisode) -> ValueReview {
    let scores = &canonical.scores;
    let reusable_signal = scores
        .reusability
        .max(scores.decision_density)
        .max(scores.failure_value);
    let score = quality_value_score(scores);
    let mut reasons = Vec::new();
    if score < MIN_EPISODE_VALUE_SCORE {
        reasons.push("value_score_below_60".to_string());
    }
    if scores.importance < MIN_EPISODE_IMPORTANCE {
        reasons.push("importance_below_55".to_string());
    }
    if scores.confidence < MIN_EPISODE_CONFIDENCE {
        reasons.push("confidence_below_55".to_string());
    }
    if reusable_signal < MIN_EPISODE_REUSABLE_SIGNAL {
        reasons.push("reusable_signal_below_50".to_string());
    }
    if scores.evidence_quality < MIN_EPISODE_EVIDENCE_QUALITY {
        reasons.push("evidence_quality_below_50".to_string());
    }
    if scores.compression_quality < MIN_EPISODE_COMPRESSION_QUALITY {
        reasons.push("compression_quality_below_45".to_string());
    }
    ValueReview {
        publish: reasons.is_empty(),
        score,
        reasons,
    }
}

pub(super) fn quality_value_score(scores: &EpisodeScores) -> i64 {
    ((scores.importance as f64 * 0.22)
        + (scores.confidence as f64 * 0.18)
        + (scores.reusability as f64 * 0.14)
        + (scores.decision_density as f64 * 0.1)
        + (scores.failure_value as f64 * 0.1)
        + (scores.causal_clarity as f64 * 0.1)
        + (scores.project_specificity as f64 * 0.06)
        + (scores.evidence_quality as f64 * 0.05)
        + (scores.compression_quality as f64 * 0.05))
        .round() as i64
}

pub(super) fn canonical_json(canonical: &CanonicalEpisode) -> Value {
    json!({
        "title": canonical.title,
        "context": canonical.context,
        "intent": canonical.intent,
        "keyDecisions": canonical.key_decisions,
        "actionTaken": canonical.action_taken,
        "outcome": canonical.outcome,
        "failedApproach": canonical.failed_approach,
        "reusableLesson": canonical.reusable_lesson,
        "usefulFutureTriggers": canonical.useful_future_triggers,
        "openLoops": canonical.open_loops,
        "generationKind": canonical.generation_kind,
        "outcomeKind": canonical.outcome_kind,
        "domains": canonical.domains,
        "technologies": canonical.technologies,
        "changeTypes": canonical.change_types,
        "tools": canonical.tools,
        "scores": scores_json(&canonical.scores)
    })
}

pub(super) fn scores_json(scores: &EpisodeScores) -> Value {
    json!({
        "importance": scores.importance,
        "confidence": scores.confidence,
        "reusability": scores.reusability,
        "decision_density": scores.decision_density,
        "failure_value": scores.failure_value,
        "causal_clarity": scores.causal_clarity,
        "project_specificity": scores.project_specificity,
        "evidence_quality": scores.evidence_quality,
        "compression_quality": scores.compression_quality,
        "staleness_risk": scores.staleness_risk
    })
}

pub(super) fn value_review_json(review: &ValueReview) -> Value {
    json!({
        "publish": review.publish,
        "score": review.score,
        "reasons": review.reasons
    })
}

pub(super) fn clamp_scores(mut scores: EpisodeScores) -> EpisodeScores {
    scores.importance = clamp_score(scores.importance);
    scores.confidence = clamp_score(scores.confidence);
    scores.reusability = clamp_score(scores.reusability);
    scores.decision_density = clamp_score(scores.decision_density);
    scores.failure_value = clamp_score(scores.failure_value);
    scores.causal_clarity = clamp_score(scores.causal_clarity);
    scores.project_specificity = clamp_score(scores.project_specificity);
    scores.evidence_quality = clamp_score(scores.evidence_quality);
    scores.compression_quality = clamp_score(scores.compression_quality);
    scores.staleness_risk = clamp_score(scores.staleness_risk);
    scores
}

pub(super) fn clamp_score(value: i64) -> i64 {
    value.clamp(0, 100)
}

pub(super) fn normalize_generation_kind(value: &str) -> String {
    match value {
        "failure_episode" | "decision_episode" => value.to_string(),
        _ => "task_episode".to_string(),
    }
}

pub(super) fn normalize_outcome_kind(value: &str) -> String {
    match value {
        "success" | "failure" | "mixed" => value.to_string(),
        _ => "unknown".to_string(),
    }
}

pub(super) fn default_score() -> i64 {
    50
}

pub(super) fn deserialize_score<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let number = match value {
        Value::Number(number) => number.as_f64(),
        Value::String(raw) => raw.trim().parse::<f64>().ok(),
        Value::Bool(value) => Some(if value { 100.0 } else { 0.0 }),
        _ => None,
    }
    .unwrap_or(50.0);
    let scaled = if number > 0.0 && number <= 1.0 {
        number * 100.0
    } else {
        number
    };
    Ok((scaled.round() as i64).clamp(0, 100))
}

pub(super) fn default_generation_kind() -> String {
    "task_episode".to_string()
}

pub(super) fn default_outcome_kind() -> String {
    "unknown".to_string()
}

pub(super) fn unique_strings(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if seen.insert(value.to_string()) {
            result.push(value.to_string());
        }
    }
    result
}

pub(super) fn join_list(values: &[String], fallback: &str) -> String {
    let items = values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| format!("- {value}"))
        .collect::<Vec<_>>();
    if items.is_empty() {
        fallback.to_string()
    } else {
        items.join("\n")
    }
}
