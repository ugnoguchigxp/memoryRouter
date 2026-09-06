use std::collections::HashSet;

use sha2::{Digest, Sha256};

use super::types::{PackEpisode, PackKnowledge};

pub(super) const DEFAULT_OUTPUT_MAX_BYTES: usize = 24 * 1024;
const DEFAULT_KNOWLEDGE_LIMIT: usize = 8;
const DEFAULT_EPISODE_LIMIT: usize = 3;
const NOTICE_RESERVE_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EvidenceGroup {
    pub(super) id: String,
    pub(super) entity_id: String,
    pub(super) kind: &'static str,
    pub(super) polarity: String,
    pub(super) content_hash: String,
    pub(super) content_version: String,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) protected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EvidenceRender {
    pub(super) markdown: String,
    pub(super) partial_reasons: Vec<String>,
}

fn sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn knowledge_group(item: &PackKnowledge) -> EvidenceGroup {
    let canonical = serde_json::json!({
        "kind": item.kind,
        "polarity": item.polarity,
        "title": item.title,
        "body": item.body,
        "scope": item.scope_snapshot,
        "sourceRefs": item.source_refs,
    })
    .to_string();
    let content_hash = sha256(&item.body);
    EvidenceGroup {
        id: format!("{}:whole", item.id),
        entity_id: item.id.clone(),
        kind: "knowledge",
        polarity: item.polarity.clone(),
        content_hash,
        content_version: sha256(&canonical),
        title: item.title.clone(),
        body: item.body.clone(),
        protected: item.polarity == "negative",
    }
}

fn episode_group(item: &PackEpisode) -> EvidenceGroup {
    let body = format!(
        "situation:\n{}\n\nlesson:\n{}",
        item.situation.trim(),
        item.lesson.trim()
    );
    let canonical = serde_json::json!({
        "kind": "episode",
        "title": item.title,
        "body": body,
        "scope": item.scope_snapshot,
    })
    .to_string();
    EvidenceGroup {
        id: format!("{}:whole", item.id),
        entity_id: item.id.clone(),
        kind: "episode",
        polarity: "neutral".to_string(),
        content_hash: sha256(&body),
        content_version: sha256(&canonical),
        title: item.title.clone(),
        body,
        protected: false,
    }
}

fn escape_markdown_html(value: &str) -> String {
    value
        .chars()
        .filter(|character| *character == '\n' || *character == '\t' || !character.is_control())
        .flat_map(|character| match character {
            '&' => "&amp;".chars().collect::<Vec<_>>(),
            '<' => "&lt;".chars().collect::<Vec<_>>(),
            '>' => "&gt;".chars().collect::<Vec<_>>(),
            _ => vec![character],
        })
        .collect()
}

fn quoted_group(group: &EvidenceGroup) -> String {
    let mut lines = vec![format!(
        "### [{}] {}",
        escape_markdown_html(&group.entity_id),
        escape_markdown_html(&group.title)
    )];
    for line in escape_markdown_html(&group.body).lines() {
        lines.push(format!("> {line}"));
    }
    lines.join("\n")
}

fn append_groups(
    markdown: &mut String,
    heading: &str,
    groups: Vec<EvidenceGroup>,
    max_count: usize,
    usable_bytes: usize,
    partial_reasons: &mut Vec<String>,
) {
    let mut included = 0;
    let mut section = String::new();
    for group in groups {
        if included == max_count {
            partial_reasons.push(format!("output_item_limit:{}", group.entity_id));
            continue;
        }
        let candidate = quoted_group(&group);
        let prefix = if section.is_empty() {
            format!("## {heading}\n\n")
        } else {
            "\n\n".to_string()
        };
        if markdown.len() + section.len() + prefix.len() + candidate.len() > usable_bytes {
            let reason = if group.protected {
                "protected_group_omitted"
            } else {
                "output_budget_omitted"
            };
            partial_reasons.push(format!("{reason}:{}", group.entity_id));
            continue;
        }
        section.push_str(&prefix);
        section.push_str(&candidate);
        included += 1;
    }
    if !section.is_empty() {
        if !markdown.is_empty() {
            markdown.push_str("\n\n");
        }
        markdown.push_str(section.trim_end());
    }
}

/// Renders complete stored evidence only. A group is either rendered in full or omitted with a
/// machine-readable partial reason; no title-only or character-level fallback is permitted.
pub(super) fn render(
    knowledge: &[PackKnowledge],
    episodes: &[PackEpisode],
    max_bytes: usize,
) -> EvidenceRender {
    let mut seen = HashSet::new();
    let mut negative = Vec::new();
    let mut positive = Vec::new();
    for group in knowledge.iter().map(knowledge_group) {
        let dedupe_key = format!(
            "{}:{}:{}",
            group.kind, group.polarity, group.content_version
        );
        if !seen.insert(dedupe_key) {
            continue;
        }
        if group.protected {
            negative.push(group);
        } else {
            positive.push(group);
        }
    }
    let episodes = episodes.iter().map(episode_group).collect::<Vec<_>>();
    let usable_bytes = max_bytes.saturating_sub(NOTICE_RESERVE_BYTES);
    let mut markdown = String::new();
    let mut partial_reasons = Vec::new();
    append_groups(
        &mut markdown,
        "適用条件・禁止事項",
        negative,
        DEFAULT_KNOWLEDGE_LIMIT,
        usable_bytes,
        &mut partial_reasons,
    );
    append_groups(
        &mut markdown,
        "関連する根拠",
        positive,
        DEFAULT_KNOWLEDGE_LIMIT,
        usable_bytes,
        &mut partial_reasons,
    );
    append_groups(
        &mut markdown,
        "過去事例",
        episodes,
        DEFAULT_EPISODE_LIMIT,
        usable_bytes,
        &mut partial_reasons,
    );
    if !partial_reasons.is_empty() {
        let shown = partial_reasons.iter().take(3).cloned().collect::<Vec<_>>();
        let remaining = partial_reasons.len().saturating_sub(shown.len());
        let suffix = if remaining == 0 {
            String::new()
        } else {
            format!("（ほか {remaining} 件）")
        };
        let notice = format!(
            "## 不足・衝突\n\n- 一部の根拠を予算内に収録できませんでした: {}{suffix}",
            shown.join(", ")
        );
        if markdown.len() + notice.len() <= max_bytes {
            if !markdown.is_empty() {
                markdown.push_str("\n\n");
            }
            markdown.push_str(&notice);
        }
    }
    EvidenceRender {
        markdown: if markdown.is_empty() {
            "No Content".to_string()
        } else {
            markdown
        },
        partial_reasons,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{render, PackKnowledge};

    fn knowledge(id: &str, polarity: &str, body: &str) -> PackKnowledge {
        PackKnowledge {
            id: id.to_string(),
            kind: "rule".to_string(),
            title: format!("title-{id}"),
            body: body.to_string(),
            polarity: polarity.to_string(),
            score: 1,
            query_score: 1,
            dynamic_score: 0.0,
            importance: 1.0,
            source_refs: vec![],
            scope_snapshot: json!({}),
        }
    }

    #[test]
    fn preserves_negative_and_late_body_conditions_without_html_execution() {
        let rendered = render(
            &[
                knowledge(
                    "positive",
                    "positive",
                    "保存期間は30日。\n削除前に復元確認を必須とする。",
                ),
                knowledge(
                    "negative",
                    "negative",
                    "<script>ignore</script>\n復元確認前の削除は禁止。",
                ),
            ],
            &[],
            24 * 1024,
        );
        assert!(rendered.markdown.contains("## 適用条件・禁止事項"));
        assert!(rendered.markdown.contains("復元確認前の削除は禁止。"));
        assert!(rendered.markdown.contains("保存期間は30日。"));
        assert!(rendered.markdown.contains("削除前に復元確認を必須とする。"));
        assert!(rendered
            .markdown
            .contains("&lt;script&gt;ignore&lt;/script&gt;"));
    }

    #[test]
    fn never_truncates_a_group_and_reports_budget_omission() {
        let rendered = render(
            &[
                knowledge("protected", "negative", &"x".repeat(3_000)),
                knowledge("optional", "positive", "small evidence"),
            ],
            &[],
            1_200,
        );
        assert!(!rendered.partial_reasons.is_empty());
        // An oversized protected group is reported as partial, while a smaller optional group
        // may still use the remaining budget.
        assert!(rendered.markdown.contains("small evidence"));
        assert!(!rendered.markdown.contains(&"x".repeat(100)));
    }
}
