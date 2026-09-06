use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProviderCall {
    pub provider: String,
    pub succeeded: bool,
    pub latency_ms: f64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reported_model: Option<String>,
}

pub(super) struct ChatCompletion {
    pub content: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reported_model: Option<String>,
}
