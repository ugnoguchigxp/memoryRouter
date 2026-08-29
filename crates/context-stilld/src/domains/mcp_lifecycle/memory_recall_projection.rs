use serde::Serialize;

use super::memory_recall_contract::MemoryType;

#[derive(Clone)]
pub(crate) struct RawExperience {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) situation: String,
    pub(crate) action: String,
    pub(crate) outcome: String,
    pub(crate) lesson: String,
    pub(crate) outcome_kind: String,
    pub(crate) score: i64,
    pub(crate) sort_at: String,
}

#[derive(Clone)]
pub(crate) struct RawKnowledge {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) polarity: String,
    pub(crate) score: i64,
    pub(crate) sort_at: String,
}

#[derive(Clone)]
pub(crate) enum RawMemory {
    Experience(RawExperience),
    Rule(RawKnowledge),
    Skill(RawKnowledge),
}

#[derive(Clone)]
pub(crate) struct ProjectedMemory {
    pub(crate) id: String,
    pub(crate) score: i64,
    pub(crate) sort_at: String,
    pub(crate) memory_type: MemoryType,
    pub(crate) value: ProjectedValue,
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub(crate) enum ProjectedValue {
    Experience(ProjectedExperience),
    Rule(ProjectedRule),
    Skill(ProjectedSkill),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectedExperience {
    pub(crate) title: String,
    pub(crate) situation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) outcome: Option<String>,
    pub(crate) lesson: String,
    pub(crate) outcome_kind: String,
}

#[derive(Clone, Serialize)]
pub(crate) struct ProjectedRule {
    pub(crate) title: String,
    pub(crate) rule: String,
    pub(crate) polarity: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectedSkill {
    pub(crate) title: String,
    pub(crate) use_when: String,
    pub(crate) workflow: Vec<String>,
    pub(crate) verification: Vec<String>,
    pub(crate) avoid: Vec<String>,
}

pub(crate) fn project(raw: RawMemory) -> Result<ProjectedMemory, &'static str> {
    match raw {
        RawMemory::Experience(raw) => project_experience(raw),
        RawMemory::Rule(raw) => project_rule(raw),
        RawMemory::Skill(raw) => project_skill(raw),
    }
}

fn project_experience(raw: RawExperience) -> Result<ProjectedMemory, &'static str> {
    let title = required(&raw.title).map_err(|_| "MALFORMED_EXPERIENCE_PROJECTION")?;
    let situation = required(&raw.situation).map_err(|_| "MALFORMED_EXPERIENCE_PROJECTION")?;
    let lesson = required(&raw.lesson).map_err(|_| "MALFORMED_EXPERIENCE_PROJECTION")?;
    let outcome_kind =
        required(&raw.outcome_kind).map_err(|_| "MALFORMED_EXPERIENCE_PROJECTION")?;
    if !["success", "failure", "mixed", "unknown"].contains(&outcome_kind.as_str()) {
        return Err("MALFORMED_EXPERIENCE_PROJECTION");
    }
    let action = optional(&raw.action).map_err(|_| "MALFORMED_EXPERIENCE_PROJECTION")?;
    let outcome = optional(&raw.outcome).map_err(|_| "MALFORMED_EXPERIENCE_PROJECTION")?;
    Ok(ProjectedMemory {
        id: raw.id,
        score: raw.score,
        sort_at: raw.sort_at,
        memory_type: MemoryType::Experience,
        value: ProjectedValue::Experience(ProjectedExperience {
            title,
            situation,
            action,
            outcome,
            lesson,
            outcome_kind,
        }),
    })
}

fn project_rule(raw: RawKnowledge) -> Result<ProjectedMemory, &'static str> {
    let title = required(&raw.title).map_err(|_| "MALFORMED_RULE_PROJECTION")?;
    let rule = required(&raw.body).map_err(|_| "MALFORMED_RULE_PROJECTION")?;
    let polarity = required(&raw.polarity).map_err(|_| "MALFORMED_RULE_PROJECTION")?;
    if !["positive", "negative", "neutral"].contains(&polarity.as_str()) {
        return Err("MALFORMED_RULE_PROJECTION");
    }
    Ok(ProjectedMemory {
        id: raw.id,
        score: raw.score,
        sort_at: raw.sort_at,
        memory_type: MemoryType::Rule,
        value: ProjectedValue::Rule(ProjectedRule {
            title,
            rule,
            polarity,
        }),
    })
}

fn project_skill(raw: RawKnowledge) -> Result<ProjectedMemory, &'static str> {
    let title = required(&raw.title).map_err(|_| "MALFORMED_SKILL_PROJECTION")?;
    let sections = parse_skill_body(&raw.body).ok_or("MALFORMED_SKILL_PROJECTION")?;
    Ok(ProjectedMemory {
        id: raw.id,
        score: raw.score,
        sort_at: raw.sort_at,
        memory_type: MemoryType::Skill,
        value: ProjectedValue::Skill(ProjectedSkill {
            title,
            use_when: sections.use_when,
            workflow: sections.workflow,
            verification: sections.verification,
            avoid: sections.avoid,
        }),
    })
}

#[derive(Debug, Eq, PartialEq)]
struct SkillSections {
    use_when: String,
    workflow: Vec<String>,
    verification: Vec<String>,
    avoid: Vec<String>,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum Section {
    UseWhen,
    Workflow,
    Verification,
    Avoid,
}

fn parse_skill_body(body: &str) -> Option<SkillSections> {
    let body = normalize(body)?;
    let mut current = None;
    let mut seen = Vec::new();
    let mut use_when = Vec::new();
    let mut workflow = Vec::new();
    let mut verification = Vec::new();
    let mut avoid = Vec::new();
    let mut fence: Option<&str> = None;

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            fence = if fence == Some("```") {
                None
            } else if fence.is_none() {
                Some("```")
            } else {
                fence
            };
            continue;
        } else if trimmed.starts_with("~~~") {
            fence = if fence == Some("~~~") {
                None
            } else if fence.is_none() {
                Some("~~~")
            } else {
                fence
            };
            continue;
        }

        if fence.is_none() {
            if let Some((section, inline)) = heading(line) {
                if seen.contains(&section)
                    || seen
                        .last()
                        .is_some_and(|previous| section_index(section) <= section_index(*previous))
                {
                    return None;
                }
                seen.push(section);
                current = Some(section);
                if !inline.is_empty() {
                    push_section(
                        section,
                        inline,
                        &mut use_when,
                        &mut workflow,
                        &mut verification,
                        &mut avoid,
                    );
                }
                continue;
            }
        }

        if let Some(section) = current {
            let value = strip_list_marker(trimmed);
            if !value.is_empty() {
                push_section(
                    section,
                    value,
                    &mut use_when,
                    &mut workflow,
                    &mut verification,
                    &mut avoid,
                );
            }
        }
    }

    if seen
        != [
            Section::UseWhen,
            Section::Workflow,
            Section::Verification,
            Section::Avoid,
        ]
        || use_when.is_empty()
        || workflow.is_empty()
        || workflow.len() > 6
        || verification.is_empty()
        || verification.len() > 4
        || avoid.is_empty()
        || avoid.len() > 4
    {
        return None;
    }
    Some(SkillSections {
        use_when: use_when.join("\n"),
        workflow,
        verification,
        avoid,
    })
}

fn heading(line: &str) -> Option<(Section, &str)> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let (label, inline) = line.split_once([':', '：'])?;
    let label = label.trim().to_ascii_lowercase();
    let section = match label.as_str() {
        "use when" => Section::UseWhen,
        "workflow" => Section::Workflow,
        "verification" => Section::Verification,
        "avoid" => Section::Avoid,
        _ => return None,
    };
    Some((section, inline.trim()))
}

fn section_index(section: Section) -> usize {
    match section {
        Section::UseWhen => 0,
        Section::Workflow => 1,
        Section::Verification => 2,
        Section::Avoid => 3,
    }
}

fn push_section(
    section: Section,
    value: &str,
    use_when: &mut Vec<String>,
    workflow: &mut Vec<String>,
    verification: &mut Vec<String>,
    avoid: &mut Vec<String>,
) {
    match section {
        Section::UseWhen => use_when.push(value.to_string()),
        Section::Workflow => workflow.push(value.to_string()),
        Section::Verification => verification.push(value.to_string()),
        Section::Avoid => avoid.push(value.to_string()),
    }
}

fn strip_list_marker(line: &str) -> &str {
    let line = line
        .strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .unwrap_or(line);
    let digit_count = line.chars().take_while(char::is_ascii_digit).count();
    if digit_count > 0 {
        let suffix = &line[digit_count..];
        if let Some(value) = suffix.strip_prefix(". ") {
            return value.trim();
        }
    }
    line.trim()
}

fn required(value: &str) -> Result<String, &'static str> {
    let value = normalize(value).ok_or("MALFORMED_MEMORY")?;
    if value.is_empty() {
        return Err("MALFORMED_MEMORY");
    }
    Ok(value)
}

fn optional(value: &str) -> Result<Option<String>, &'static str> {
    match normalize(value) {
        None => Err("MALFORMED_MEMORY"),
        Some(value) if value.is_empty() => Ok(None),
        Some(value) => Ok(Some(value)),
    }
}

fn normalize(value: &str) -> Option<String> {
    if value.contains('\0') {
        return None;
    }
    Some(
        value
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .trim()
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_inline_and_list_skill_sections() {
        let sections = parse_skill_body(
            "Use when： releasing safely\nWorkflow:\n1. Run tests\n2. Deploy\nVerification: health is green\nAvoid:\n- Skipping checks",
        )
        .unwrap();
        assert_eq!(sections.use_when, "releasing safely");
        assert_eq!(sections.workflow, ["Run tests", "Deploy"]);
        assert_eq!(sections.verification, ["health is green"]);
        assert_eq!(sections.avoid, ["Skipping checks"]);
    }

    #[test]
    fn ignores_heading_like_text_in_fences() {
        let sections = parse_skill_body(
            "Use when: x\nWorkflow:\n```text\nVerification: not a heading\n```\n- step\nVerification: checked\nAvoid: guessing",
        )
        .unwrap();
        assert_eq!(sections.verification, ["checked"]);
    }

    #[test]
    fn rejects_duplicate_reordered_or_oversized_sections() {
        assert!(parse_skill_body("Workflow: x\nUse when: y\nVerification: z\nAvoid: a").is_none());
        assert!(parse_skill_body(
            "Use when: x\nWorkflow: y\nWorkflow: z\nVerification: q\nAvoid: a"
        )
        .is_none());
        assert!(parse_skill_body("Use when: x\nWorkflow:\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g\nVerification: q\nAvoid: z").is_none());
    }
}
