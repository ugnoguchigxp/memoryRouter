use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(super) struct PackKnowledge {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) title: String,
    pub(super) body: String,
    pub(super) polarity: String,
    pub(super) score: i64,
    pub(super) query_score: i64,
    pub(super) dynamic_score: f64,
    pub(super) importance: f64,
    pub(super) source_refs: Vec<String>,
    pub(super) scope_snapshot: Value,
}

impl PackKnowledge {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "kind": "knowledge",
            "id": self.id,
            "type": self.kind,
            "title": self.title,
            "body": self.body,
            "polarity": self.polarity,
            "score": self.score,
            "sourceRefs": self.source_refs
        })
    }
}

#[derive(Debug, Clone)]
pub(super) struct PackEpisode {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) situation: String,
    pub(super) lesson: String,
    pub(super) score: i64,
    pub(super) query_score: i64,
    pub(super) importance: f64,
    pub(super) scope_snapshot: Value,
}

impl PackEpisode {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "kind": "episode",
            "id": self.id,
            "title": self.title,
            "situation": self.situation,
            "lesson": self.lesson,
            "score": self.score
        })
    }
}

#[derive(Debug)]
pub(super) struct ComposeResult {
    pub(super) markdown: String,
    pub(super) agentic_used: bool,
    pub(super) error: Option<String>,
    pub(super) used_knowledge: Vec<UsedKnowledge>,
    pub(super) used_episodes: Vec<UsedEpisode>,
}

#[derive(Debug, Clone)]
pub(super) struct UsedKnowledge {
    pub(super) id: String,
    pub(super) confidence: f64,
    pub(super) evidence: Option<String>,
    pub(super) output_section: Option<String>,
    pub(super) reason: Option<String>,
}

impl UsedKnowledge {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "confidence": self.confidence,
            "evidence": self.evidence,
            "outputSection": self.output_section,
            "reason": self.reason
        })
    }
}

#[derive(Debug, Clone)]
pub(super) struct UsedEpisode {
    pub(super) id: String,
    pub(super) confidence: f64,
    pub(super) evidence: Option<String>,
    pub(super) output_section: Option<String>,
    pub(super) reason: Option<String>,
}

impl UsedEpisode {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "confidence": self.confidence,
            "evidence": self.evidence,
            "outputSection": self.output_section,
            "reason": self.reason
        })
    }
}

#[derive(Debug, Clone)]
pub(super) struct ComposePlan {
    pub(super) focus: String,
    pub(super) steps: String,
    pub(super) verification: String,
    pub(super) avoid: String,
    pub(super) include_avoid_section: bool,
    pub(super) response_style: String,
}

impl Default for ComposePlan {
    fn default() -> Self {
        Self {
            focus: "実装フォーカス".to_string(),
            steps: "実装手順".to_string(),
            verification: "検証観点".to_string(),
            avoid: "注意点".to_string(),
            include_avoid_section: false,
            response_style: "narrative".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct RuntimeSettings {
    pub(super) agentic_enabled: bool,
    pub(super) provider: String,
    pub(super) fallback: Vec<String>,
    pub(super) timeout_ms: u64,
    pub(super) max_tokens: i64,
    pub(super) azure: Option<AzureSettings>,
    pub(super) local: Option<LocalLlmSettings>,
    pub(super) openai: Option<OpenAiSettings>,
    pub(super) local_llm_model: Option<String>,
}

#[derive(Debug, Clone)]
pub(super) struct AzureSettings {
    pub(super) api_key: String,
    pub(super) api_base_url: String,
    pub(super) api_path: String,
    pub(super) api_version: String,
    pub(super) model: String,
}

#[derive(Debug, Clone)]
pub(super) struct LocalLlmSettings {
    pub(super) api_key: String,
    pub(super) api_base_url: String,
    pub(super) api_path: String,
    pub(super) model: String,
}

#[derive(Debug, Clone)]
pub(super) struct OpenAiSettings {
    pub(super) api_key: String,
    pub(super) api_base_url: String,
    pub(super) model: String,
}
