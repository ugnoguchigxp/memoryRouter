use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use regex::Regex;
use reqwest::Url;
use serde_json::{json, Value};

use super::applicability::merge_execution_applicability;
use super::external_fetch::{fetch_guarded_external_url_with_text_limit, read_bounded_body};
use super::helpers::truncate;
use super::types::{NegativeCoveringExecution, LOCAL_SOURCE_BYTE_LIMIT};

#[derive(Debug, Clone)]
pub(super) struct PositiveSourceRead {
    pub(super) content: String,
    pub(super) read_ranges: Vec<(usize, usize)>,
}

pub(super) fn positive_source_content(
    execution: &NegativeCoveringExecution,
    timeout_seconds: u64,
) -> Result<PositiveSourceRead, String> {
    let content = match execution.source_kind.as_str() {
        "vibe_memory" => normalize_markdown_source(&execution.source_content),
        "knowledge_candidate" => {
            return Ok(PositiveSourceRead {
                content: truncate(&execution.candidate_content, 24_000),
                read_ranges: vec![(0, execution.candidate_content.chars().count())],
            })
        }
        "wiki_file" => normalize_markdown_source(&read_bounded_local_source(
            &execution.source_read_root.join("pages"),
            &execution.source_key,
        )?),
        "web_ingest" => {
            fetch_guarded_external_url_with_text_limit(
                &execution.source_uri,
                timeout_seconds,
                LOCAL_SOURCE_BYTE_LIMIT,
            )?
            .text
        }
        other => return Err(format!("unsupported_source_kind:{other}")),
    };
    if content.len() > LOCAL_SOURCE_BYTE_LIMIT {
        return Err("source_read_exceeded_byte_limit".to_string());
    }
    let mut source_read =
        slice_source_token_ranges(&content, &configured_source_read_ranges(execution));
    source_read.content = truncate(&source_read.content, 24_000);
    Ok(source_read)
}

pub(super) fn configured_source_read_ranges(
    execution: &NegativeCoveringExecution,
) -> Vec<(usize, usize)> {
    let ranges = execution
        .candidate_origin
        .get("readRanges")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|range| {
            let from = usize::try_from(range.get("from")?.as_u64()?).ok()?;
            let to_exclusive = usize::try_from(range.get("toExclusive")?.as_u64()?).ok()?;
            (to_exclusive > from)
                .then_some((from, from.saturating_add((to_exclusive - from).min(6_000))))
        })
        .take(8)
        .collect::<Vec<_>>();
    if ranges.is_empty() {
        vec![(0, 1_500)]
    } else {
        ranges
    }
}

pub(super) fn slice_source_token_ranges(
    content: &str,
    ranges: &[(usize, usize)],
) -> PositiveSourceRead {
    let spans = Regex::new(r"(?u)\S+")
        .expect("source token regex")
        .find_iter(content)
        .map(|matched| (matched.start(), matched.end()))
        .collect::<Vec<_>>();
    let mut windows = Vec::new();
    let mut read_ranges = Vec::new();
    for (from, requested_to) in ranges {
        if *from >= spans.len() {
            read_ranges.push((*from, *from));
            continue;
        }
        let to_exclusive = (*requested_to).min(spans.len());
        if to_exclusive <= *from {
            read_ranges.push((*from, *from));
            continue;
        }
        windows.push(content[spans[*from].0..spans[to_exclusive - 1].1].to_string());
        read_ranges.push((*from, to_exclusive));
    }
    PositiveSourceRead {
        content: windows.join("\n\n---\n\n"),
        read_ranges,
    }
}

pub(super) fn normalize_markdown_source(content: &str) -> String {
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let without_frontmatter = if let Some(content) = normalized.strip_prefix("---\n") {
        content
            .find("\n---\n")
            .map(|offset| content[offset + 5..].to_string())
            .unwrap_or(normalized)
    } else {
        normalized
    };
    let without_links = Regex::new(r"!?\[([^\]]*)\]\([^)]*\)")
        .expect("markdown link regex")
        .replace_all(&without_frontmatter, "$1");
    let without_reference_links = Regex::new(r"\[([^\]]+)\]\[[^\]]*\]")
        .expect("markdown reference link regex")
        .replace_all(&without_links, "$1");
    let without_fences = Regex::new(r"(?m)^\s*```[^\n]*$|^\s*~~~[^\n]*$")
        .expect("markdown fence regex")
        .replace_all(&without_reference_links, " ");
    let without_block_markers = Regex::new(r"(?m)^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)")
        .expect("markdown block marker regex")
        .replace_all(&without_fences, "");
    let without_bold = Regex::new(r"\*\*([^*\n]+)\*\*")
        .expect("markdown bold regex")
        .replace_all(&without_block_markers, "$1");
    let without_underscore_bold = Regex::new(r"__([^_\n]+)__")
        .expect("markdown underscore bold regex")
        .replace_all(&without_bold, "$1");
    let without_strikethrough = Regex::new(r"~~([^~\n]+)~~")
        .expect("markdown strikethrough regex")
        .replace_all(&without_underscore_bold, "$1");
    let without_inline_markers = Regex::new(r"`([^`\n]+)`")
        .expect("markdown inline code regex")
        .replace_all(&without_strikethrough, "$1");
    without_inline_markers
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn read_bounded_local_source(root: &Path, raw_path: &str) -> Result<String, String> {
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("source_root_unavailable:{}:{error}", root.display()))?;
    let decoded = if raw_path.trim_start().starts_with("file://") {
        let url = Url::parse(raw_path.trim())
            .map_err(|error| format!("source_path_invalid_file_url:{error}"))?;
        let local_host = url
            .host_str()
            .is_none_or(|host| host.is_empty() || host.eq_ignore_ascii_case("localhost"));
        if url.scheme() != "file"
            || !url.username().is_empty()
            || url.password().is_some()
            || !local_host
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("source_path_invalid_file_url".to_string());
        }
        url.to_file_path()
            .map_err(|_| "source_path_invalid_file_url".to_string())?
    } else {
        let path = PathBuf::from(raw_path.trim());
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let path = std::fs::canonicalize(&decoded)
        .map_err(|error| format!("source_read_failed:{}:{error}", decoded.display()))?;
    if path != root && !path.starts_with(&root) {
        return Err(format!(
            "source_path_outside_root:{}:{}",
            root.display(),
            path.display()
        ));
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("source_read_failed:{}:{error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("source_path_not_file:{}", path.display()));
    }
    if metadata.len() > LOCAL_SOURCE_BYTE_LIMIT as u64 {
        return Err(format!(
            "source_read_exceeded_byte_limit:{}",
            path.display()
        ));
    }
    let file = std::fs::File::open(&path)
        .map_err(|error| format!("source_read_failed:{}:{error}", path.display()))?;
    let bytes = read_bounded_body(file, LOCAL_SOURCE_BYTE_LIMIT, "source_read")?;
    String::from_utf8(bytes)
        .map_err(|error| format!("source_read_invalid_utf8:{}:{error}", path.display()))
}

pub(super) fn source_reference(execution: &NegativeCoveringExecution) -> Vec<Value> {
    let uri = if execution.source_uri.trim().is_empty() {
        format!("agent://candidate/{}", execution.found_candidate_id)
    } else {
        execution.source_uri.clone()
    };
    if execution.source_kind == "knowledge_candidate" {
        return vec![json!({
            "kind": "source",
            "uri": uri,
            "locator": "candidate:content",
            "note": "registered candidate content",
            "evidenceRole": "supports_candidate"
        })];
    }
    execution
        .source_read_ranges
        .clone()
        .unwrap_or_else(|| configured_source_read_ranges(execution))
        .into_iter()
        .map(|(from, to_exclusive)| {
            json!({
                "kind": "source",
                "uri": uri,
                "locator": format!("tokens:{from}-{to_exclusive}"),
                "note": "candidate origin read range",
                "evidenceRole": "supports_candidate"
            })
        })
        .collect()
}

pub(super) fn normalized_character_count(value: &str) -> usize {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .count()
}

pub(super) fn knowledge_tokens(value: &str) -> Vec<String> {
    let normalized = value.to_lowercase();
    let pattern =
        Regex::new(r"(?u)[a-z0-9][a-z0-9._:/@+\-]{2,}|[\p{Han}\p{Hiragana}\p{Katakana}ー]{2,}")
            .expect("covering knowledge token regex");
    let stop_words = [
        "the", "and", "for", "with", "that", "this", "from", "into", "should", "must", "する",
        "した", "して", "ます", "です", "こと", "ため", "よう",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    let mut tokens = BTreeSet::new();
    for matched in pattern.find_iter(&normalized) {
        let token = matched.as_str().trim();
        if token.is_empty() || stop_words.contains(token) {
            continue;
        }
        tokens.insert(token.to_string());
        if token.chars().all(|character| !character.is_ascii()) {
            let characters = token.chars().collect::<Vec<_>>();
            for index in (0..characters.len().saturating_sub(3)).step_by(2) {
                tokens.insert(characters[index..index + 4].iter().collect());
            }
        }
    }
    tokens.into_iter().collect()
}

pub(super) fn evaluate_positive_source_support(
    candidate_body: &str,
    source: &str,
) -> (bool, i64, f64) {
    let normalized_source = source.to_lowercase();
    let normalized_body = candidate_body.trim().to_lowercase();
    let exact = !normalized_body.is_empty() && normalized_source.contains(&normalized_body);
    let tokens = knowledge_tokens(candidate_body)
        .into_iter()
        .take(32)
        .collect::<Vec<_>>();
    let matched = tokens
        .iter()
        .filter(|token| normalized_source.contains(token.as_str()))
        .count();
    let ratio = if tokens.is_empty() {
        0.0
    } else {
        matched as f64 / tokens.len() as f64
    };
    let required = (tokens.len() as f64 * 0.25).ceil() as usize;
    let ok = exact || matched >= required.clamp(2, 4) || ratio >= 0.35;
    let confidence = if ok {
        (62.0 + ratio * 25.0 + if exact { 8.0 } else { 0.0 })
            .round()
            .clamp(0.0, 92.0) as i64
    } else {
        (35.0 + ratio * 30.0).round() as i64
    };
    (ok, confidence, ratio)
}

pub(super) fn score_hint(value: Option<&Value>) -> Option<i64> {
    let numeric = value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str()?.parse::<f64>().ok())
    })?;
    let normalized = if (0.0..=1.0).contains(&numeric) {
        numeric * 100.0
    } else {
        numeric
    };
    Some(normalized.round().clamp(0.0, 100.0) as i64)
}

pub(super) fn infer_positive_importance(title: &str, body: &str) -> i64 {
    let text = format!("{title}\n{body}").to_lowercase();
    if Regex::new(
        r"(?i)(must|never|required|failure|error|security|verify|必ず|禁止|失敗|エラー|検証|安全)",
    )
    .expect("importance regex")
    .is_match(&text)
    {
        82
    } else if Regex::new(r"(?i)(should|prefer|avoid|推奨|避ける|注意)")
        .expect("importance regex")
        .is_match(&text)
    {
        74
    } else {
        68
    }
}

pub(super) fn base_positive_candidate(
    execution: &NegativeCoveringExecution,
    confidence: i64,
) -> Value {
    let candidate_type = execution
        .candidate_origin
        .get("candidateType")
        .or_else(|| execution.candidate_origin.get("typeHint"))
        .or_else(|| execution.candidate_origin.get("type"))
        .and_then(Value::as_str)
        .unwrap_or(&execution.candidate_type);
    let applies_to = merge_execution_applicability(execution, &json!({}));
    json!({
        "type": if candidate_type == "procedure" { "procedure" } else { "rule" },
        "title": execution.candidate_title,
        "body": execution.candidate_content,
        "importance": score_hint(execution.candidate_origin.get("importance"))
            .unwrap_or_else(|| infer_positive_importance(&execution.candidate_title, &execution.candidate_content)),
        "confidence": score_hint(execution.candidate_origin.get("confidence")).unwrap_or(confidence.clamp(0, 100)),
        "appliesTo": applies_to
    })
}

pub(super) fn requires_external_evidence(title: &str, body: &str) -> bool {
    let text = format!("{title}\n{body}");
    let direct = Regex::new(r"(?i)\bhttps?://|\b(pricing|rate limits?|official docs?|official documentation|public docs?|public documentation|public spec(?:ification)?s?)\b|料金|レート制限|公開仕様|公式ドキュメント|公式資料")
        .expect("external evidence direct regex");
    let freshness = Regex::new(r"(?i)\b(latest|current|currently|up-to-date)\b|現在|最新")
        .expect("external evidence freshness regex");
    let subject = Regex::new(r"(?i)\b(api|docs?|documentation|reference|spec(?:ification)?s?|provider|models?|package|library|sdk)\b|API|ドキュメント|仕様|資料|モデル名|パッケージ|ライブラリ")
        .expect("external evidence subject regex");
    direct.is_match(&text) || (freshness.is_match(&text) && subject.is_match(&text))
}
