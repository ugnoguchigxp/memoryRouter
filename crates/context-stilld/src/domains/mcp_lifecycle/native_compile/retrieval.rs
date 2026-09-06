use std::collections::HashSet;

use rusqlite::Connection;

use super::super::native_common::{score_text, table_exists};
use super::super::repository_scope::{
    applicability_general, eligible_scope_clause, facets_allow, json_string_array,
    parse_json_object, query_params, scope_snapshot, RepositoryRequestFacets,
};

use super::types::{PackEpisode, PackKnowledge};

// Shared by the production split pipeline and the paired evaluation runner.
pub(super) const KNOWLEDGE_CANDIDATE_LIMIT: usize = 256;
pub(super) const EPISODE_CANDIDATE_LIMIT: usize = 96;
pub(super) const KNOWLEDGE_PACK_LIMIT: usize = 8;
pub(super) const EPISODE_PACK_LIMIT: usize = 3;

/// Detect an incompatible retrieval schema before treating a failed query as an empty result.
/// Missing optional tables remain a degraded condition for backward compatibility; a table that
/// exists but cannot satisfy the compile projection is a failed compile request.
pub(super) fn validate_retrieval_schema(connection: &Connection) -> Result<(), String> {
    if table_exists(connection, "knowledge_items") {
        connection
            .prepare(
                "select id, type, polarity, title, body, dynamic_score, applies_to, scope, project_ref, repo_key, repo_path, importance from knowledge_items limit 0",
            )
            .map_err(|error| format!("knowledge retrieval schema is incompatible: {error}"))?;
    }
    if table_exists(connection, "episode_cards") {
        connection
            .prepare(
                "select id, title, situation, lesson, importance, technologies, change_types, domains, applicability, scope, project_ref, repo_key, repo_path from episode_cards limit 0",
            )
            .map_err(|error| format!("episode retrieval schema is incompatible: {error}"))?;
    }
    Ok(())
}

pub(super) fn search_text(
    goal: &str,
    technologies: &[String],
    change_types: &[String],
    domains: &[String],
) -> String {
    [&[goal.to_string()][..], technologies, change_types, domains]
        .concat()
        .join(" ")
}

pub(super) fn search_knowledge_items(
    connection: &Connection,
    query: &str,
    limit: usize,
    identity: &super::super::project_identity::ResolvedCompileProjectIdentity,
    request_facets: &RepositoryRequestFacets,
    include_query_matches: bool,
) -> Vec<PackKnowledge> {
    if !table_exists(connection, "knowledge_items") {
        return Vec::new();
    }
    let (scope_clause, values) = eligible_scope_clause(identity);
    let sql = format!(
        r#"
        select id, type, polarity, title, body, coalesce(dynamic_score, 0), applies_to,
               scope, project_ref, repo_key, repo_path, coalesce(importance, 0)
        from knowledge_items
        where status = 'active' and {scope_clause}
        order by importance desc, updated_at desc
        "#,
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map(query_params(&values), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, f64>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, Option<String>>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, f64>(11)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = rows
        .flatten()
        .filter_map(
            |(
                id,
                kind,
                polarity,
                title,
                body,
                dynamic_score,
                applies_to_raw,
                item_scope,
                project_ref,
                repo_key,
                repo_path,
                importance,
            )| {
                let applies_to = parse_json_object(&applies_to_raw);
                let technologies = json_string_array(&applies_to, "technologies");
                let change_types = json_string_array(&applies_to, "changeTypes");
                let domains = json_string_array(&applies_to, "domains");
                if !facets_allow(
                    request_facets,
                    &technologies,
                    &change_types,
                    &domains,
                    applicability_general(&applies_to, &technologies, &change_types, &domains),
                ) {
                    return None;
                }
                let query_score = score_text(&format!("{title}\n{body}"), query);
                let score = query_score + dynamic_score.round() as i64;
                (score > 0 || (include_query_matches && query_score > 0)).then(|| PackKnowledge {
                    source_refs: knowledge_source_refs(connection, &id),
                    scope_snapshot: scope_snapshot(
                        identity,
                        &item_scope,
                        project_ref.as_deref(),
                        repo_key.as_deref(),
                        repo_path.as_deref(),
                    ),
                    id,
                    kind,
                    title,
                    body,
                    polarity,
                    score,
                    query_score,
                    dynamic_score,
                    importance,
                })
            },
        )
        .collect::<Vec<_>>();
    if !include_query_matches {
        items.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.id.cmp(&right.id))
        });
        items.truncate(limit);
        return items;
    }
    foundation_candidate_pool(
        items,
        limit,
        8,
        |item| item.query_score > 0,
        |left, right| {
            right
                .query_score
                .cmp(&left.query_score)
                .then_with(|| {
                    normalized_ranking_score(right.dynamic_score, 0.0, 100.0)
                        .cmp(&normalized_ranking_score(left.dynamic_score, 0.0, 100.0))
                })
                .then_with(|| {
                    normalized_ranking_score(right.importance, 0.0, 100.0)
                        .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
                })
                .then_with(|| left.id.cmp(&right.id))
        },
    )
}

pub(super) fn search_episode_cards(
    connection: &Connection,
    query: &str,
    limit: usize,
    identity: &super::super::project_identity::ResolvedCompileProjectIdentity,
    request_facets: &RepositoryRequestFacets,
    include_query_matches: bool,
) -> Vec<PackEpisode> {
    if !table_exists(connection, "episode_cards") {
        return Vec::new();
    }
    let (scope_clause, values) = eligible_scope_clause(identity);
    let sql = format!(
        r#"
        select id, title, situation, lesson, importance, technologies, change_types, domains,
               applicability, scope, project_ref, repo_key, repo_path
        from episode_cards
        where status = 'active' and {scope_clause}
        order by importance desc, updated_at desc
        "#,
    );
    let mut statement = match connection.prepare(&sql) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map(query_params(&values), |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, Option<String>>(12)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    let mut items = rows
        .flatten()
        .filter_map(
            |(
                id,
                title,
                situation,
                lesson,
                importance,
                technologies_raw,
                change_types_raw,
                domains_raw,
                applicability_raw,
                item_scope,
                project_ref,
                repo_key,
                repo_path,
            )| {
                let technologies =
                    serde_json::from_str::<Vec<String>>(&technologies_raw).unwrap_or_default();
                let change_types =
                    serde_json::from_str::<Vec<String>>(&change_types_raw).unwrap_or_default();
                let domains = serde_json::from_str::<Vec<String>>(&domains_raw).unwrap_or_default();
                let applicability = parse_json_object(&applicability_raw);
                if !facets_allow(
                    request_facets,
                    &technologies,
                    &change_types,
                    &domains,
                    applicability_general(&applicability, &technologies, &change_types, &domains),
                ) {
                    return None;
                }
                let query_score = score_text(&format!("{title}\n{situation}\n{lesson}"), query);
                let score = query_score + importance / 10;
                (score > 0 || (include_query_matches && query_score > 0)).then_some(PackEpisode {
                    id,
                    title,
                    situation,
                    lesson,
                    score,
                    query_score,
                    importance: importance as f64,
                    scope_snapshot: scope_snapshot(
                        identity,
                        &item_scope,
                        project_ref.as_deref(),
                        repo_key.as_deref(),
                        repo_path.as_deref(),
                    ),
                })
            },
        )
        .collect::<Vec<_>>();
    if !include_query_matches {
        items.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.id.cmp(&right.id))
        });
        items.truncate(limit);
        return items;
    }
    foundation_candidate_pool(
        items,
        limit,
        3,
        |item| item.query_score > 0,
        |left, right| {
            right
                .query_score
                .cmp(&left.query_score)
                .then_with(|| {
                    normalized_ranking_score(right.importance, 0.0, 100.0)
                        .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
                })
                .then_with(|| left.id.cmp(&right.id))
        },
    )
}

pub(super) fn foundation_candidate_pool<T, QueryMatched, FoundationOrder>(
    items: Vec<T>,
    limit: usize,
    legacy_budget: usize,
    query_matched: QueryMatched,
    foundation_order: FoundationOrder,
) -> Vec<T>
where
    T: Clone + CandidateIdentity + LegacyScored,
    QueryMatched: Fn(&T) -> bool,
    FoundationOrder: Fn(&T, &T) -> std::cmp::Ordering,
{
    let mut legacy = items.iter().collect::<Vec<_>>();
    legacy.sort_by(|left, right| legacy_candidate_order(*left, *right));
    legacy.truncate(legacy_budget.min(limit));

    let mut query_matched = items
        .iter()
        .filter(|item| query_matched(item))
        .collect::<Vec<_>>();
    query_matched.sort_by(|left, right| foundation_order(*left, *right));

    let mut selected = Vec::with_capacity(limit);
    let mut seen = HashSet::new();
    for item in legacy.into_iter().chain(query_matched) {
        if seen.insert(item.candidate_id().to_string()) {
            selected.push((*item).clone());
            if selected.len() == limit {
                break;
            }
        }
    }
    selected
}

pub(super) trait CandidateIdentity {
    fn candidate_id(&self) -> &str;
}

pub(super) trait LegacyScored {
    fn legacy_score(&self) -> i64;
}

pub(super) fn legacy_candidate_order<T: LegacyScored + CandidateIdentity>(
    left: &T,
    right: &T,
) -> std::cmp::Ordering {
    right
        .legacy_score()
        .cmp(&left.legacy_score())
        .then_with(|| left.candidate_id().cmp(right.candidate_id()))
}

impl CandidateIdentity for PackKnowledge {
    fn candidate_id(&self) -> &str {
        &self.id
    }
}

impl LegacyScored for PackKnowledge {
    fn legacy_score(&self) -> i64 {
        self.score
    }
}

impl CandidateIdentity for PackEpisode {
    fn candidate_id(&self) -> &str {
        &self.id
    }
}

impl LegacyScored for PackEpisode {
    fn legacy_score(&self) -> i64 {
        self.score
    }
}

pub(super) fn normalized_ranking_score(value: f64, lower: f64, upper: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    value.clamp(lower, upper).round() as i64
}

pub(super) fn foundation_score(query_score: i64, dynamic_score: f64, importance: f64) -> i64 {
    query_score
        .saturating_mul(10_000)
        .saturating_add(normalized_ranking_score(dynamic_score, 0.0, 100.0).saturating_mul(100))
        .saturating_add(normalized_ranking_score(importance, 0.0, 100.0))
}

pub(super) fn knowledge_source_refs(connection: &Connection, knowledge_id: &str) -> Vec<String> {
    let mut statement = match connection.prepare(
        r#"
        select s.uri, sf.locator
        from knowledge_source_links ksl
        join source_fragments sf on sf.id = ksl.source_fragment_id
        join sources s on s.id = sf.source_id
        where ksl.knowledge_id = ?1
        order by ksl.confidence desc, ksl.created_at desc
        limit 5
        "#,
    ) {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    statement
        .query_map([knowledge_id], |row| {
            let uri: String = row.get(0)?;
            let locator: String = row.get(1)?;
            Ok(format!("{uri}#{locator}"))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
}

pub(super) fn degraded_reasons(connection: &Connection) -> Vec<String> {
    let mut reasons = Vec::new();
    if !table_exists(connection, "knowledge_items") {
        reasons.push("knowledge_items_missing".to_string());
    }
    if !table_exists(connection, "episode_cards") {
        reasons.push("episode_cards_missing".to_string());
    }
    reasons
}

pub(super) fn rank_foundation_knowledge(candidates: &[PackKnowledge]) -> Vec<PackKnowledge> {
    let mut knowledge = candidates
        .iter()
        .filter(|item| item.query_score > 0)
        .cloned()
        .collect::<Vec<_>>();
    knowledge.sort_by(|left, right| {
        right
            .query_score
            .cmp(&left.query_score)
            .then_with(|| {
                normalized_ranking_score(right.dynamic_score, 0.0, 100.0)
                    .cmp(&normalized_ranking_score(left.dynamic_score, 0.0, 100.0))
            })
            .then_with(|| {
                normalized_ranking_score(right.importance, 0.0, 100.0)
                    .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    for item in &mut knowledge {
        item.score = foundation_score(item.query_score, item.dynamic_score, item.importance);
    }
    knowledge.truncate(KNOWLEDGE_PACK_LIMIT);
    knowledge
}

pub(super) fn rank_foundation_episodes(candidates: &[PackEpisode]) -> Vec<PackEpisode> {
    let mut episodes = candidates
        .iter()
        .filter(|item| item.query_score > 0)
        .cloned()
        .collect::<Vec<_>>();
    episodes.sort_by(|left, right| {
        right
            .query_score
            .cmp(&left.query_score)
            .then_with(|| {
                normalized_ranking_score(right.importance, 0.0, 100.0)
                    .cmp(&normalized_ranking_score(left.importance, 0.0, 100.0))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
    for item in &mut episodes {
        item.score = foundation_score(item.query_score, 0.0, item.importance);
    }
    episodes.truncate(EPISODE_PACK_LIMIT);
    episodes
}
