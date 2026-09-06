use super::super::*;
use super::{claim_json, config, connection_json};

#[test]
fn settings_are_disabled_by_default_and_reject_unsafe_origins() {
    let settings = serde_json::json!({
        "providers": {
            "larm-agent-connection": { "enabled": false, "connections": [] }
        }
    });
    assert_eq!(
        LarmConnectionConfig::from_settings(&settings, "contextstill-background").unwrap(),
        None
    );
    let malformed = serde_json::json!({
        "providers": {
            "larm-agent-connection": { "enabled": "yes", "connections": [] }
        }
    });
    assert!(LarmConnectionConfig::from_settings(&malformed, "contextstill-background").is_err());

    let unsafe_config = config("https://example.com");
    assert!(unsafe_config.validate().is_err());
    assert!(config("http://gnosis.local:9810").validate().is_ok());
    assert!(config("http://127.0.0.1:9810").validate().is_ok());
    assert!(config("http://127.0.0.1:44448").validate().is_err());
    assert!(config("http://localhost:44448").validate().is_err());
    let mut path_segment_config = config("http://127.0.0.1:9810");
    path_segment_config.agent_profile = "..".to_string();
    assert!(path_segment_config.validate().is_err());
}

#[test]
fn claim_rejects_an_oversized_credential() {
    let origin = "http://127.0.0.1:9810";
    let client = LarmControlClient::new(config(origin)).unwrap();
    let connection = serde_json::from_value::<PublicLarmConnection>(connection_json()).unwrap();
    let mut claim_value = claim_json(origin);
    claim_value["providers"][0]["credential"]["token"] =
        Value::String("x".repeat(MAX_CREDENTIAL_TOKEN_BYTES + 1));
    let claim = serde_json::from_value::<LarmClaim>(claim_value).unwrap();

    let error = client.validate_claim(&connection, claim).unwrap_err();

    assert_eq!(error.kind, "protocol");
    assert!(error.message.contains("provider contract mismatch"));
}

#[test]
fn claim_rejects_the_legacy_static_loopback_endpoint() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9810")).unwrap();
    let connection = serde_json::from_value::<PublicLarmConnection>(connection_json()).unwrap();
    let claim = serde_json::from_value::<LarmClaim>(claim_json("http://127.0.0.1:44448")).unwrap();

    let error = client.validate_claim(&connection, claim).unwrap_err();

    assert_eq!(error.kind, "protocol");
    assert!(error.message.contains("legacy static Provider port 44448"));
}

#[test]
fn timestamp_parser_rejects_noncanonical_and_invalid_dates() {
    assert_eq!(parse_rfc3339_utc_ms("2026-02-29T12:00:00Z"), None);
    assert_eq!(parse_rfc3339_utc_ms("2026-9-06T12:00:00Z"), None);
    assert_eq!(parse_rfc3339_utc_ms("2026-09-06T1:00:00Z"), None);
    assert!(parse_rfc3339_utc_ms("2024-02-29T12:00:00.123Z").is_some());
}
