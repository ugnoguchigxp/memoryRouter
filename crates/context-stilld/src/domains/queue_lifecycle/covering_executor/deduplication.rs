use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use crate::shared::errors::CliError;

use super::helpers::truncate;

pub(super) fn inspect_knowledge_duplicates(
    connection: &Connection,
    candidate_title: &str,
    candidate_body: &str,
) -> Result<(Option<String>, Vec<Value>), CliError> {
    let table_present = connection
        .query_row(
            "select exists(select 1 from sqlite_master where type = 'table' and name = 'knowledge_items')",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        != 0;
    if !table_present {
        return Ok((None, Vec::new()));
    }
    let title_probe = truncate(candidate_title.trim(), 48);
    let body_probe = truncate(candidate_body.trim(), 64);
    let mut statement = connection
        .prepare(
            "
            select id, title, body
            from knowledge_items
            where status in ('active', 'draft')
              and (
                lower(title) = lower(?1)
                or lower(body) = lower(?2)
                or instr(lower(title), lower(?3)) > 0
                or instr(lower(body), lower(?4)) > 0
              )
            order by updated_at desc, id asc
            limit 40
            ",
        )
        .map_err(|error| CliError::io(format!("failed to prepare covering dedupe: {error}")))?;
    let rows = statement
        .query_map(
            params![candidate_title, candidate_body, title_probe, body_probe],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| CliError::io(format!("failed to query covering dedupe: {error}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| CliError::io(format!("failed to read covering dedupe: {error}")))?;
    let normalized_title = normalize_dedupe_text(candidate_title);
    let normalized_body = normalize_dedupe_text(candidate_body);
    let mut scored = rows
        .into_iter()
        .map(|(id, title, body)| {
            let title_score = bigram_similarity(candidate_title, &title);
            let body_score = bigram_similarity(candidate_body, &body);
            let score = body_score.max(title_score * 0.6 + body_score * 0.4);
            let exact = normalize_dedupe_text(&title) == normalized_title
                && normalize_dedupe_text(&body) == normalized_body;
            (id, title, score, exact)
        })
        // Similarity is diagnostic only.  v2 must never discard a supported candidate
        // solely because a semantically close knowledge item exists.
        .filter(|(_, _, score, exact)| *exact || *score >= 0.62)
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.2.total_cmp(&a.2));
    let refs = scored
        .iter()
        .take(5)
        .map(|(id, title, score, _)| {
            json!({
                "knowledgeId": id,
                "title": title,
                "score": (score * 1000.0).round() / 1000.0,
                "reason": format!("covering rust bigram similarity:{score:.3}")
            })
        })
        .collect::<Vec<_>>();
    let status = scored.first().and_then(|(_, _, _score, exact)| {
        if *exact {
            Some("duplicate".to_string())
        } else {
            None
        }
    });
    Ok((status, refs))
}

pub(super) fn normalize_dedupe_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn bigram_similarity(first: &str, second: &str) -> f64 {
    let bigrams = |value: &str| -> HashSet<String> {
        let normalized = normalize_dedupe_text(value);
        let characters = normalized.chars().collect::<Vec<_>>();
        if characters.len() < 2 {
            return [normalized]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect();
        }
        characters
            .windows(2)
            .map(|window| window.iter().collect::<String>())
            .collect()
    };
    let left = bigrams(first);
    let right = bigrams(second);
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count();
    2.0 * intersection as f64 / (left.len() + right.len()) as f64
}
