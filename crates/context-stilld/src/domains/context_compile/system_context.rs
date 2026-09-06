use sha2::{Digest, Sha256};

use serde::Deserialize;

use crate::domains::mcp_lifecycle::native_compile::selector;

const STATIC_PROMPTS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../.s11tnext/compile-prompts.generated.json"
));
const SELECTOR_SCHEMA: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../shared/context-compile/selector-output.schema.json"
));

const FORMAT: &str = "context-still.compile-static-prompts";
const KEY: &str = "contextCompiler.selectEvidence";

#[derive(Debug, Deserialize)]
struct Artifact {
    format: String,
    version: u8,
    messages: Vec<Message>,
}

#[derive(Debug, Deserialize)]
struct Message {
    key: String,
    locale: String,
    role: String,
    text: String,
    #[serde(rename = "rawUtf8Sha256")]
    raw_utf8_sha256: String,
    #[serde(rename = "selectorSchemaSha256")]
    selector_schema_sha256: String,
}

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// Checks the TypeScript-produced static system prompt before a native compile runtime starts.
/// Rust deliberately validates ordinary SHA-256 bytes only; s11tnext manifest interpretation stays
/// owned by the TypeScript exporter.
pub fn verify_static_selector_artifact() -> Result<(), String> {
    verify_artifact(STATIC_PROMPTS, SELECTOR_SCHEMA)?;
    selector::validate(
        r#"{"schemaVersion":1,"decisions":[],"orderedOptionalIds":[]}"#,
        "",
        &[],
    )
    .map_err(|error| format!("selector validator contract is unavailable: {error}"))
}

fn verify_artifact(raw: &str, schema: &[u8]) -> Result<(), String> {
    let artifact: Artifact = serde_json::from_str(raw)
        .map_err(|error| format!("compile prompt artifact is invalid JSON: {error}"))?;
    if artifact.format != FORMAT || artifact.version != 1 {
        return Err("compile prompt artifact format/version is unsupported".to_string());
    }
    if artifact.messages.len() != 2 {
        return Err("compile prompt artifact must contain exactly two locales".to_string());
    }
    let schema_hash = sha256(schema);
    let mut locales = artifact
        .messages
        .iter()
        .map(|message| message.locale.as_str())
        .collect::<Vec<_>>();
    locales.sort_unstable();
    if locales != ["en-US", "ja-JP"] {
        return Err("compile prompt artifact must contain ja-JP and en-US".to_string());
    }
    for message in artifact.messages {
        if message.key != KEY || message.role != "system" || message.text.trim().is_empty() {
            return Err("compile prompt artifact has an invalid selector message".to_string());
        }
        if message.raw_utf8_sha256 != sha256(message.text.as_bytes()) {
            return Err(format!(
                "compile prompt text hash mismatch: {}",
                message.locale
            ));
        }
        if message.selector_schema_sha256 != schema_hash {
            return Err(format!(
                "compile selector schema hash mismatch: {}",
                message.locale
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        verify_artifact, verify_static_selector_artifact, SELECTOR_SCHEMA, STATIC_PROMPTS,
    };

    #[test]
    fn verifies_the_generated_bilingual_static_selector() {
        verify_static_selector_artifact().unwrap();
    }

    #[test]
    fn rejects_tampered_text_and_schema_hashes() {
        let text_tampered = STATIC_PROMPTS.replacen("根拠選択器", "改ざん", 1);
        assert!(verify_artifact(&text_tampered, SELECTOR_SCHEMA).is_err());

        let schema_tampered = b"{}";
        assert!(verify_artifact(STATIC_PROMPTS, schema_tampered).is_err());
    }
}
