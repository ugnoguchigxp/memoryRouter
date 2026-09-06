use std::fmt;
use std::io::Read;
use std::net::IpAddr;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::blocking::{Client, Response};
use reqwest::header::{CACHE_CONTROL, CONTENT_TYPE};
use reqwest::{StatusCode, Url};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroizing;

const MAX_CONTROL_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_CONTROL_URL_BYTES: usize = 4 * 1024;
const MAX_CREDENTIAL_TOKEN_BYTES: usize = 16 * 1024;
const MAX_PROTOCOL_FIELD_BYTES: usize = 1024;
const MAX_AVAILABILITY_RETRY_AFTER_MS: u64 = 300_000;
const MAX_CLOCK_FUTURE_SKEW_MS: u64 = 5_000;
const REQUEST_CLEANUP_MARGIN_MS: u64 = 30_000;
const AGENT_CONNECTION_CONTRACT: &str = "openai-provider-v1";
const AVAILABILITY_CONTRACT: &str = "agent-profile-availability.v1";
const OPENAI_PROTOCOL: &str = "openai.chat-completions.v1";

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LarmConnectionConfig {
    pub id: String,
    pub control_base_url: String,
    pub agent_profile: String,
    pub audience: String,
    pub availability_poll_ms: u64,
    pub availability_timeout_ms: u64,
    pub control_timeout_ms: u64,
    pub ready_timeout_ms: u64,
    pub ttl_seconds: u64,
    pub request_timeout_ms: u64,
}

impl fmt::Debug for LarmConnectionConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LarmConnectionConfig")
            .field("id", &self.id)
            .field("control_base_url", &self.control_base_url)
            .field("agent_profile", &self.agent_profile)
            .field("audience", &self.audience)
            .field("availability_poll_ms", &self.availability_poll_ms)
            .field("availability_timeout_ms", &self.availability_timeout_ms)
            .field("control_timeout_ms", &self.control_timeout_ms)
            .field("ready_timeout_ms", &self.ready_timeout_ms)
            .field("ttl_seconds", &self.ttl_seconds)
            .field("request_timeout_ms", &self.request_timeout_ms)
            .finish()
    }
}

impl LarmConnectionConfig {
    pub fn from_settings(
        settings: &Value,
        connection_id: &str,
    ) -> Result<Option<Self>, LarmControlError> {
        let Some(provider) = settings.pointer("/providers/larm-agent-connection") else {
            return Ok(None);
        };
        match provider.get("enabled").and_then(Value::as_bool) {
            Some(false) => return Ok(None),
            Some(true) => {}
            None => {
                return Err(LarmControlError::configuration(
                    "LARM provider enabled must be a boolean",
                ));
            }
        }
        let connections = provider
            .get("connections")
            .and_then(Value::as_array)
            .ok_or_else(|| LarmControlError::configuration("LARM connections must be an array"))?;
        let matching = connections
            .iter()
            .filter(|connection| {
                connection.get("id").and_then(Value::as_str) == Some(connection_id)
            })
            .collect::<Vec<_>>();
        if matching.is_empty() {
            return Err(LarmControlError::configuration(format!(
                "LARM connection is not configured: {connection_id}"
            )));
        }
        if matching.len() != 1 {
            return Err(LarmControlError::configuration(format!(
                "LARM connection id is duplicated: {connection_id}"
            )));
        }
        let config = serde_json::from_value::<Self>((*matching[0]).clone()).map_err(|error| {
            LarmControlError::configuration(format!(
                "invalid LARM connection configuration for {connection_id}: {error}"
            ))
        })?;
        config.validate()?;
        Ok(Some(config))
    }

    pub fn validate(&self) -> Result<(), LarmControlError> {
        validate_identifier("connection id", &self.id)?;
        validate_identifier("agent profile", &self.agent_profile)?;
        validate_identifier("audience", &self.audience)?;
        validate_control_origin(&self.control_base_url)?;
        if !(1_000..=300_000).contains(&self.availability_poll_ms) {
            return Err(LarmControlError::configuration(
                "availabilityPollMs must be between 1000 and 300000",
            ));
        }
        if !(250..=30_000).contains(&self.availability_timeout_ms) {
            return Err(LarmControlError::configuration(
                "availabilityTimeoutMs must be between 250 and 30000",
            ));
        }
        if !(250..=120_000).contains(&self.control_timeout_ms) {
            return Err(LarmControlError::configuration(
                "controlTimeoutMs must be between 250 and 120000",
            ));
        }
        if !(1_000..=900_000).contains(&self.ready_timeout_ms) {
            return Err(LarmControlError::configuration(
                "readyTimeoutMs must be between 1000 and 900000",
            ));
        }
        if !(60..=86_400).contains(&self.ttl_seconds) {
            return Err(LarmControlError::configuration(
                "ttlSeconds must be between 60 and 86400",
            ));
        }
        if !(1_000..=3_600_000).contains(&self.request_timeout_ms) {
            return Err(LarmControlError::configuration(
                "requestTimeoutMs must be between 1000 and 3600000",
            ));
        }
        if self.ttl_seconds.saturating_mul(1_000) < self.request_timeout_ms.saturating_add(30_000) {
            return Err(LarmControlError::configuration(
                "ttlSeconds must cover requestTimeoutMs plus a 30 second cleanup margin",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvailabilityState {
    Available,
    Busy,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LarmAvailability {
    pub contract_version: String,
    pub agent_profile: String,
    pub audience: String,
    pub state: AvailabilityState,
    pub reason_code: String,
    pub observed_at: String,
    pub valid_for_ms: u64,
    pub retry_after_ms: u64,
    pub reservation_guaranteed: bool,
    pub catalog_revision: String,
    pub boot_epoch: String,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LarmConnectionStatus {
    Pending,
    Probing,
    Ready,
    Failed,
    Released,
    Expired,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicLarmConnectionProvider {
    pub name: String,
    pub capability: String,
    pub route: String,
    pub protocol: String,
    pub public_model: String,
    pub readiness: LarmConnectionStatus,
    pub claimable: bool,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicLarmConnectionError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicLarmConnection {
    pub id: String,
    pub allocation_id: String,
    pub boot_epoch: String,
    pub catalog_revision: String,
    pub agent_profile: String,
    pub profile_revision: String,
    pub audience: String,
    pub audience_revision: String,
    pub status: LarmConnectionStatus,
    pub providers: Vec<PublicLarmConnectionProvider>,
    pub created_at: String,
    pub expires_at: String,
    pub released_at: Option<String>,
    pub error: Option<PublicLarmConnectionError>,
}

#[derive(Eq, PartialEq)]
pub struct ClaimedLarmTarget {
    pub connection_id: String,
    pub allocation_id: String,
    pub api_base_url: String,
    pub model: String,
    pub bearer_token: Zeroizing<String>,
    pub expires_at: String,
}

impl fmt::Debug for ClaimedLarmTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ClaimedLarmTarget")
            .field("connection_id", &self.connection_id)
            .field("allocation_id", &self.allocation_id)
            .field("api_base_url", &self.api_base_url)
            .field("model", &self.model)
            .field("bearer_token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LarmClaim {
    id: String,
    allocation_id: String,
    status: LarmConnectionStatus,
    audience: String,
    providers: Vec<LarmClaimProvider>,
    expires_at: String,
}

#[derive(Debug, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LarmClaimProvider {
    name: String,
    capability: String,
    api_style: String,
    protocol: String,
    scheme: String,
    host: String,
    port: u16,
    base_url: String,
    model: String,
    health: LarmClaimHealth,
    credential: LarmClaimCredential,
    configuration: LarmClaimConfiguration,
    streaming: Option<Value>,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LarmClaimHealth {
    url: String,
    kind: String,
    max_age_ms: u64,
}

#[derive(Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LarmClaimCredential {
    #[serde(rename = "type")]
    credential_type: String,
    #[serde(deserialize_with = "deserialize_zeroizing_string")]
    token: Zeroizing<String>,
    expires_at: String,
}

impl fmt::Debug for LarmClaimCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LarmClaimCredential")
            .field("credential_type", &self.credential_type)
            .field("token", &"[REDACTED]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LarmClaimConfiguration {
    kind: String,
    fields: LarmClaimConfigurationFields,
    secret_fields: LarmClaimSecretFields,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LarmClaimConfigurationFields {
    #[serde(rename = "baseURL")]
    base_url: String,
    model: String,
}

#[derive(Debug, Clone, Eq, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LarmClaimSecretFields {
    api_key: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LarmControlError {
    pub kind: &'static str,
    pub message: String,
    pub retryable: bool,
    pub http_status: Option<u16>,
}

impl LarmControlError {
    pub(crate) fn configuration(message: impl Into<String>) -> Self {
        Self {
            kind: "configuration",
            message: message.into(),
            retryable: false,
            http_status: None,
        }
    }

    pub(crate) fn protocol(message: impl Into<String>) -> Self {
        Self {
            kind: "protocol",
            message: message.into(),
            retryable: false,
            http_status: None,
        }
    }

    fn transport(message: impl Into<String>) -> Self {
        Self {
            kind: "transport",
            message: message.into(),
            retryable: true,
            http_status: None,
        }
    }

    fn http(status: StatusCode) -> Self {
        Self {
            kind: "http",
            message: format!("LARM control request returned HTTP {}", status.as_u16()),
            retryable: matches!(
                status.as_u16(),
                408 | 409 | 425 | 429 | 500 | 502 | 503 | 504
            ),
            http_status: Some(status.as_u16()),
        }
    }
}

impl fmt::Display for LarmControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.kind, self.message)
    }
}

impl std::error::Error for LarmControlError {}

#[derive(Clone)]
pub struct LarmControlClient {
    config: LarmConnectionConfig,
    control_origin: Url,
    client: Client,
}

impl fmt::Debug for LarmControlClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LarmControlClient")
            .field("config", &self.config)
            .field("control_origin", &self.control_origin.as_str())
            .finish_non_exhaustive()
    }
}

impl LarmControlClient {
    pub fn new(config: LarmConnectionConfig) -> Result<Self, LarmControlError> {
        config.validate()?;
        let control_origin = validate_control_origin(&config.control_base_url)?;
        let client = Client::builder()
            .connect_timeout(Duration::from_millis(config.control_timeout_ms))
            .timeout(Duration::from_millis(config.control_timeout_ms))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|error| {
                LarmControlError::configuration(format!(
                    "failed to build LARM control client: {error}"
                ))
            })?;
        Ok(Self {
            config,
            control_origin,
            client,
        })
    }

    pub fn config(&self) -> &LarmConnectionConfig {
        &self.config
    }

    pub fn availability(
        &self,
        current_connection_id: Option<&str>,
    ) -> Result<LarmAvailability, LarmControlError> {
        let profile = encode_segment(&self.config.agent_profile);
        let mut url = self.endpoint(&format!("/v2/agent-profiles/{profile}/availability"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("audience", &self.config.audience);
            if let Some(connection_id) = current_connection_id {
                validate_identifier("current connection id", connection_id)?;
                query.append_pair("currentConnectionId", connection_id);
            }
        }
        let response = self
            .client
            .get(url)
            .header(CACHE_CONTROL, "no-cache")
            .timeout(Duration::from_millis(self.config.availability_timeout_ms))
            .send()
            .map_err(|error| {
                LarmControlError::transport(format!("availability failed: {error}"))
            })?;
        validate_availability_headers(&response)?;
        let availability: LarmAvailability = parse_json_response(response, StatusCode::OK)?;
        self.validate_availability(&availability)?;
        Ok(availability)
    }

    pub fn create(&self, idempotency_key: &str) -> Result<PublicLarmConnection, LarmControlError> {
        validate_idempotency_key(idempotency_key)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CreateRequest<'a> {
            agent_profile: &'a str,
            explicit_agent_profile: bool,
            audience: &'a str,
            client: &'static str,
            ttl_seconds: u64,
            allow_fallback: bool,
            deployment_policy: &'static str,
        }
        let response = self
            .client
            .post(self.endpoint("/v1/agent-connections")?)
            .header("idempotency-key", idempotency_key)
            .json(&CreateRequest {
                agent_profile: &self.config.agent_profile,
                explicit_agent_profile: true,
                audience: &self.config.audience,
                client: "contextstill",
                ttl_seconds: self.config.ttl_seconds,
                allow_fallback: false,
                deployment_policy: "existing-only",
            })
            .send()
            .map_err(|error| LarmControlError::transport(format!("create failed: {error}")))?;
        let connection: PublicLarmConnection =
            parse_json_response_allowing(response, &[StatusCode::CREATED, StatusCode::ACCEPTED])?;
        self.validate_connection(&connection)?;
        Ok(connection)
    }

    pub fn get(&self, connection_id: &str) -> Result<PublicLarmConnection, LarmControlError> {
        self.get_with_timeout(
            connection_id,
            Duration::from_millis(self.config.control_timeout_ms),
        )
    }

    fn get_with_timeout(
        &self,
        connection_id: &str,
        timeout: Duration,
    ) -> Result<PublicLarmConnection, LarmControlError> {
        validate_identifier("connection id", connection_id)?;
        let response = self
            .client
            .get(self.endpoint(&format!(
                "/v1/agent-connections/{}",
                encode_segment(connection_id)
            ))?)
            .timeout(timeout)
            .send()
            .map_err(|error| LarmControlError::transport(format!("status failed: {error}")))?;
        let connection: PublicLarmConnection = parse_json_response(response, StatusCode::OK)?;
        self.validate_connection(&connection)?;
        if connection.id != connection_id {
            return Err(LarmControlError::protocol(
                "LARM status response connection id mismatch",
            ));
        }
        Ok(connection)
    }

    pub fn wait_until_ready(
        &self,
        initial: PublicLarmConnection,
    ) -> Result<PublicLarmConnection, LarmControlError> {
        let deadline = Instant::now() + Duration::from_millis(self.config.ready_timeout_ms);
        let identity = initial.clone();
        let mut current = initial;
        loop {
            match current.status {
                LarmConnectionStatus::Ready => return Ok(current),
                LarmConnectionStatus::Pending | LarmConnectionStatus::Probing => {}
                LarmConnectionStatus::Failed
                | LarmConnectionStatus::Released
                | LarmConnectionStatus::Expired => {
                    return Err(LarmControlError::protocol(format!(
                        "LARM connection entered terminal state: {:?}",
                        current.status
                    )))
                }
            }
            if Instant::now() >= deadline {
                return Err(LarmControlError::transport(
                    "LARM connection did not become ready before the configured deadline",
                ));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            thread::sleep(Duration::from_millis(250).min(remaining));
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(LarmControlError::transport(
                    "LARM connection did not become ready before the configured deadline",
                ));
            }
            let request_timeout = remaining
                .min(Duration::from_millis(self.config.control_timeout_ms))
                .max(Duration::from_millis(1));
            current = self.get_with_timeout(&current.id, request_timeout)?;
            ensure_same_connection_identity(&identity, &current)?;
        }
    }

    pub fn claim(
        &self,
        connection: &PublicLarmConnection,
    ) -> Result<ClaimedLarmTarget, LarmControlError> {
        validate_identifier("connection id", &connection.id)?;
        if connection.status != LarmConnectionStatus::Ready {
            return Err(LarmControlError::protocol(
                "cannot claim a LARM connection before it is ready",
            ));
        }
        #[derive(Serialize)]
        struct ClaimRequest<'a> {
            format: &'a str,
        }
        let response = self
            .client
            .post(self.endpoint(&format!(
                "/v1/agent-connections/{}/claim",
                encode_segment(&connection.id)
            ))?)
            .json(&ClaimRequest {
                format: AGENT_CONNECTION_CONTRACT,
            })
            .send()
            .map_err(|error| LarmControlError::transport(format!("claim failed: {error}")))?;
        let claim: LarmClaim = parse_json_response(response, StatusCode::OK)?;
        self.validate_claim(connection, claim)
    }

    pub fn renew(
        &self,
        connection_id: &str,
        idempotency_key: &str,
    ) -> Result<PublicLarmConnection, LarmControlError> {
        validate_identifier("connection id", connection_id)?;
        validate_idempotency_key(idempotency_key)?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct RenewRequest {
            ttl_seconds: u64,
        }
        let response = self
            .client
            .post(self.endpoint(&format!(
                "/v1/agent-connections/{}/renew",
                encode_segment(connection_id)
            ))?)
            .header("idempotency-key", idempotency_key)
            .json(&RenewRequest {
                ttl_seconds: self.config.ttl_seconds,
            })
            .send()
            .map_err(|error| LarmControlError::transport(format!("renew failed: {error}")))?;
        let connection: PublicLarmConnection = parse_json_response(response, StatusCode::OK)?;
        self.validate_connection(&connection)?;
        if connection.id != connection_id {
            return Err(LarmControlError::protocol(
                "LARM renew response connection id mismatch",
            ));
        }
        Ok(connection)
    }

    pub fn release(&self, connection_id: &str) -> Result<(), LarmControlError> {
        validate_identifier("connection id", connection_id)?;
        let response = self
            .client
            .delete(self.endpoint(&format!(
                "/v1/agent-connections/{}",
                encode_segment(connection_id)
            ))?)
            .send()
            .map_err(|error| LarmControlError::transport(format!("release failed: {error}")))?;
        if response.status() != StatusCode::NO_CONTENT {
            if response.status().is_success() {
                return Err(LarmControlError::protocol(format!(
                    "LARM release returned unexpected success status {}",
                    response.status().as_u16()
                )));
            }
            return Err(LarmControlError::http(response.status()));
        }
        Ok(())
    }

    pub fn new_idempotency_key(&self, operation: &str) -> Result<String, LarmControlError> {
        validate_identifier("operation", operation)?;
        let mut entropy = [0_u8; 16];
        getrandom::fill(&mut entropy).map_err(|error| {
            LarmControlError::transport(format!("failed to generate idempotency key: {error}"))
        })?;
        let suffix = entropy
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Ok(format!("contextstill:{operation}:{suffix}"))
    }

    pub fn target_requires_renewal(
        &self,
        target: &ClaimedLarmTarget,
    ) -> Result<bool, LarmControlError> {
        let expires_at_ms = parse_rfc3339_utc_ms(&target.expires_at).ok_or_else(|| {
            LarmControlError::protocol("LARM claim expiry is not a canonical UTC timestamp")
        })?;
        let required_until_ms = now_epoch_ms()
            .saturating_add(self.config.request_timeout_ms)
            .saturating_add(REQUEST_CLEANUP_MARGIN_MS);
        Ok(expires_at_ms < required_until_ms)
    }

    fn endpoint(&self, path: &str) -> Result<Url, LarmControlError> {
        self.control_origin
            .join(path)
            .map_err(|error| LarmControlError::configuration(format!("invalid LARM path: {error}")))
    }

    fn validate_availability(
        &self,
        availability: &LarmAvailability,
    ) -> Result<(), LarmControlError> {
        if availability.contract_version != AVAILABILITY_CONTRACT {
            return Err(LarmControlError::protocol(
                "unsupported LARM availability contract version",
            ));
        }
        if availability.agent_profile != self.config.agent_profile
            || availability.audience != self.config.audience
        {
            return Err(LarmControlError::protocol(
                "LARM availability response identity mismatch",
            ));
        }
        if availability.reservation_guaranteed {
            return Err(LarmControlError::protocol(
                "LARM availability unexpectedly claimed to reserve capacity",
            ));
        }
        if availability.valid_for_ms == 0 || availability.valid_for_ms > 60_000 {
            return Err(LarmControlError::protocol(
                "LARM availability validity window is outside the supported range",
            ));
        }
        let observed_at_ms = parse_rfc3339_utc_ms(&availability.observed_at).ok_or_else(|| {
            LarmControlError::protocol(
                "LARM availability observedAt is not a canonical UTC timestamp",
            )
        })?;
        let now_ms = now_epoch_ms();
        if observed_at_ms > now_ms.saturating_add(MAX_CLOCK_FUTURE_SKEW_MS) {
            return Err(LarmControlError::protocol(
                "LARM availability observation is unreasonably far in the future",
            ));
        }
        if now_ms > observed_at_ms.saturating_add(availability.valid_for_ms) {
            return Err(LarmControlError::protocol(
                "LARM availability observation expired before it was received",
            ));
        }
        if !is_valid_identifier(&availability.reason_code)
            || availability.catalog_revision.is_empty()
            || availability.catalog_revision.len() > 256
            || availability.boot_epoch.is_empty()
            || availability.boot_epoch.len() > 256
        {
            return Err(LarmControlError::protocol(
                "LARM availability response is missing required identity fields",
            ));
        }
        let retry_after_valid = match availability.state {
            AvailabilityState::Available => availability.retry_after_ms == 0,
            AvailabilityState::Busy | AvailabilityState::Unavailable => {
                availability.retry_after_ms <= MAX_AVAILABILITY_RETRY_AFTER_MS
            }
            AvailabilityState::Unknown => availability.retry_after_ms <= 60_000,
        };
        if !retry_after_valid {
            return Err(LarmControlError::protocol(
                "LARM availability retryAfterMs does not match the reported state",
            ));
        }
        Ok(())
    }

    fn validate_connection(
        &self,
        connection: &PublicLarmConnection,
    ) -> Result<(), LarmControlError> {
        let created_at_ms = parse_rfc3339_utc_ms(&connection.created_at).ok_or_else(|| {
            LarmControlError::protocol("LARM connection createdAt is not a canonical UTC timestamp")
        })?;
        let expires_at_ms = parse_rfc3339_utc_ms(&connection.expires_at).ok_or_else(|| {
            LarmControlError::protocol("LARM connection expiresAt is not a canonical UTC timestamp")
        })?;
        if expires_at_ms <= created_at_ms {
            return Err(LarmControlError::protocol(
                "LARM connection expiry must be later than its creation time",
            ));
        }
        if connection.id.is_empty()
            || !is_bounded_nonempty(&connection.allocation_id, 256)
            || !is_bounded_nonempty(&connection.boot_epoch, 256)
            || !is_bounded_nonempty(&connection.catalog_revision, 256)
            || !is_sha256_hex(&connection.profile_revision)
            || !is_sha256_hex(&connection.audience_revision)
            || connection.created_at.is_empty()
            || connection.expires_at.is_empty()
            || connection.providers.len() != 1
        {
            return Err(LarmControlError::protocol(
                "LARM connection response is missing required fields",
            ));
        }
        if !is_valid_identifier(&connection.id)
            || connection
                .providers
                .iter()
                .any(|provider| !is_valid_identifier(&provider.name))
        {
            return Err(LarmControlError::protocol(
                "LARM connection response contains an invalid identifier",
            ));
        }
        if connection.agent_profile != self.config.agent_profile
            || connection.audience != self.config.audience
        {
            return Err(LarmControlError::protocol(
                "LARM connection response identity mismatch",
            ));
        }
        let provider = &connection.providers[0];
        if !is_bounded_nonempty(&provider.capability, MAX_PROTOCOL_FIELD_BYTES)
            || !is_bounded_nonempty(&provider.route, MAX_PROTOCOL_FIELD_BYTES)
            || provider.protocol != OPENAI_PROTOCOL
            || !is_bounded_nonempty(&provider.public_model, MAX_PROTOCOL_FIELD_BYTES)
            || (connection.status == LarmConnectionStatus::Ready
                && (provider.readiness != LarmConnectionStatus::Ready || !provider.claimable))
        {
            return Err(LarmControlError::protocol(
                "LARM connection provider is not a ready claimable OpenAI-compatible target",
            ));
        }
        if connection.status == LarmConnectionStatus::Ready
            && (connection.error.is_some() || connection.released_at.is_some())
        {
            return Err(LarmControlError::protocol(
                "ready LARM connection unexpectedly contains terminal state fields",
            ));
        }
        if let Some(released_at) = &connection.released_at {
            parse_rfc3339_utc_ms(released_at).ok_or_else(|| {
                LarmControlError::protocol(
                    "LARM connection releasedAt is not a canonical UTC timestamp",
                )
            })?;
        }
        if connection.error.as_ref().is_some_and(|error| {
            !is_bounded_nonempty(&error.code, MAX_PROTOCOL_FIELD_BYTES)
                || !is_bounded_nonempty(&error.message, 4 * MAX_PROTOCOL_FIELD_BYTES)
        }) {
            return Err(LarmControlError::protocol(
                "LARM connection error fields exceed the supported bounds",
            ));
        }
        Ok(())
    }

    fn validate_claim(
        &self,
        connection: &PublicLarmConnection,
        mut claim: LarmClaim,
    ) -> Result<ClaimedLarmTarget, LarmControlError> {
        if claim.id != connection.id
            || claim.allocation_id != connection.allocation_id
            || claim.status != LarmConnectionStatus::Ready
            || claim.audience != self.config.audience
            || claim.expires_at != connection.expires_at
            || claim.providers.len() != 1
        {
            return Err(LarmControlError::protocol(
                "LARM claim identity, state, expiry, or provider count mismatch",
            ));
        }
        let provider = claim.providers.remove(0);
        let public_provider = &connection.providers[0];
        if provider.name.is_empty()
            || provider.capability.is_empty()
            || provider.name != public_provider.name
            || provider.capability != public_provider.capability
            || provider.model != public_provider.public_model
            || provider.api_style != "openai"
            || provider.protocol != OPENAI_PROTOCOL
            || provider.health.kind != "semantic-inference"
            || provider.health.max_age_ms != 10_000
            || provider.credential.credential_type != "bearer"
            || provider.credential.token.is_empty()
            || provider.credential.token.len() > MAX_CREDENTIAL_TOKEN_BYTES
            || provider.credential.expires_at != claim.expires_at
            || provider.configuration.kind != AGENT_CONNECTION_CONTRACT
            || provider.configuration.fields.base_url != provider.base_url
            || provider.configuration.fields.model != provider.model
            || provider.configuration.secret_fields.api_key != "credential.token"
            || provider.base_url.len() > MAX_CONTROL_URL_BYTES
            || provider.health.url.len() > MAX_CONTROL_URL_BYTES
            || !is_bounded_nonempty(&provider.model, MAX_PROTOCOL_FIELD_BYTES)
            || !is_bounded_nonempty(&provider.scheme, 16)
            || !is_bounded_nonempty(&provider.host, 253)
        {
            return Err(LarmControlError::protocol(
                "LARM claim provider contract mismatch",
            ));
        }
        let expires_at_ms = parse_rfc3339_utc_ms(&claim.expires_at).ok_or_else(|| {
            LarmControlError::protocol("LARM claim expiry is not a canonical UTC timestamp")
        })?;
        let required_until_ms = now_epoch_ms()
            .saturating_add(self.config.request_timeout_ms)
            .saturating_add(REQUEST_CLEANUP_MARGIN_MS);
        if expires_at_ms < required_until_ms {
            return Err(LarmControlError::protocol(
                "LARM claim does not have enough lifetime for one request and cleanup",
            ));
        }
        let base_url = validate_claimed_provider_url(&provider, &self.control_origin)?;
        validate_claimed_health_url(&provider, &base_url, &claim.id)?;
        Ok(ClaimedLarmTarget {
            connection_id: claim.id,
            allocation_id: claim.allocation_id,
            api_base_url: base_url.as_str().trim_end_matches('/').to_string(),
            model: provider.model,
            bearer_token: provider.credential.token,
            expires_at: claim.expires_at,
        })
    }
}

pub(crate) fn ensure_same_connection_identity(
    expected: &PublicLarmConnection,
    actual: &PublicLarmConnection,
) -> Result<(), LarmControlError> {
    let expected_provider = expected.providers.first();
    let actual_provider = actual.providers.first();
    if expected.id != actual.id
        || expected.allocation_id != actual.allocation_id
        || expected.boot_epoch != actual.boot_epoch
        || expected.catalog_revision != actual.catalog_revision
        || expected.agent_profile != actual.agent_profile
        || expected.profile_revision != actual.profile_revision
        || expected.audience != actual.audience
        || expected.audience_revision != actual.audience_revision
        || expected_provider.map(|provider| {
            (
                &provider.name,
                &provider.capability,
                &provider.route,
                &provider.protocol,
                &provider.public_model,
            )
        }) != actual_provider.map(|provider| {
            (
                &provider.name,
                &provider.capability,
                &provider.route,
                &provider.protocol,
                &provider.public_model,
            )
        })
    {
        return Err(LarmControlError::protocol(
            "LARM connection identity changed during its lifecycle",
        ));
    }
    Ok(())
}

fn parse_json_response<T: DeserializeOwned>(
    response: Response,
    expected_status: StatusCode,
) -> Result<T, LarmControlError> {
    parse_json_response_allowing(response, &[expected_status])
}

fn parse_json_response_allowing<T: DeserializeOwned>(
    mut response: Response,
    expected_statuses: &[StatusCode],
) -> Result<T, LarmControlError> {
    let status = response.status();
    if !expected_statuses.contains(&status) {
        if status.is_success() {
            return Err(LarmControlError::protocol(format!(
                "LARM control response returned unexpected success status {}",
                status.as_u16()
            )));
        }
        return Err(LarmControlError::http(status));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.split(';').next().map(str::trim) != Some("application/json") {
        return Err(LarmControlError::protocol(
            "LARM control response content type is not application/json",
        ));
    }
    let mut body = Zeroizing::new(Vec::new());
    response
        .by_ref()
        .take((MAX_CONTROL_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut body)
        .map_err(|error| {
            LarmControlError::transport(format!("failed to read LARM response: {error}"))
        })?;
    if body.len() > MAX_CONTROL_RESPONSE_BYTES {
        return Err(LarmControlError::protocol(
            "LARM control response exceeded the configured size limit",
        ));
    }
    serde_json::from_slice(body.as_slice())
        .map_err(|error| LarmControlError::protocol(format!("invalid LARM control JSON: {error}")))
}

fn validate_availability_headers(response: &Response) -> Result<(), LarmControlError> {
    if !response.status().is_success() {
        return Err(LarmControlError::http(response.status()));
    }
    let cache_control = response
        .headers()
        .get(CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !cache_control
        .split(',')
        .any(|directive| directive.trim() == "no-store")
    {
        return Err(LarmControlError::protocol(
            "LARM availability response must include Cache-Control: no-store",
        ));
    }
    Ok(())
}

fn deserialize_zeroizing_string<'de, D>(deserializer: D) -> Result<Zeroizing<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    String::deserialize(deserializer).map(Zeroizing::new)
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn parse_rfc3339_utc_ms(value: &str) -> Option<u64> {
    let date_time = value.strip_suffix('Z')?;
    let (date, time) = date_time.split_once('T')?;
    if date.len() != 10
        || date.as_bytes().get(4) != Some(&b'-')
        || date.as_bytes().get(7) != Some(&b'-')
        || !date
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
        || time.len() < 8
        || time.as_bytes().get(2) != Some(&b':')
        || time.as_bytes().get(5) != Some(&b':')
    {
        return None;
    }
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i32>().ok()?;
    let month = date_parts.next()?.parse::<u32>().ok()?;
    let day = date_parts.next()?.parse::<u32>().ok()?;
    if date_parts.next().is_some() || year < 1970 || !(1..=12).contains(&month) {
        return None;
    }
    let max_day = days_in_month(year, month);
    if day == 0 || day > max_day {
        return None;
    }

    let mut time_parts = time.split(':');
    let hour = time_parts.next()?.parse::<u32>().ok()?;
    let minute = time_parts.next()?.parse::<u32>().ok()?;
    let seconds = time_parts.next()?;
    if time_parts.next().is_some()
        || hour > 23
        || minute > 59
        || !time.as_bytes()[0..2]
            .iter()
            .chain(time.as_bytes()[3..5].iter())
            .all(u8::is_ascii_digit)
    {
        return None;
    }
    let (second_text, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    let second = second_text.parse::<u32>().ok()?;
    if second_text.len() != 2
        || second > 59
        || !second_text.bytes().all(|byte| byte.is_ascii_digit())
        || (!fraction.is_empty() && !fraction.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }
    if seconds.contains('.') && fraction.is_empty() {
        return None;
    }
    let mut millis = 0_u32;
    for (index, digit) in fraction.bytes().take(3).enumerate() {
        millis += u32::from(digit - b'0') * [100, 10, 1][index];
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    Some(
        (days as u64)
            .saturating_mul(86_400_000)
            .saturating_add(u64::from(hour) * 3_600_000)
            .saturating_add(u64::from(minute) * 60_000)
            .saturating_add(u64::from(second) * 1_000)
            .saturating_add(u64::from(millis)),
    )
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => 0,
    }
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year - (month <= 2) as i32;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    i64::from(era * 146_097 + day_of_era - 719_468)
}

#[cfg(test)]
pub(crate) fn current_rfc3339_for_test() -> String {
    rfc3339_for_test(now_epoch_ms())
}

#[cfg(test)]
fn rfc3339_for_test(epoch_ms: u64) -> String {
    let total_seconds = epoch_ms / 1_000;
    let days = (total_seconds / 86_400) as i64;
    let seconds_of_day = total_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        epoch_ms % 1_000
    )
}

#[cfg(test)]
fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = (year_of_era + era * 400) as i32;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += (month <= 2) as i32;
    (year, month as u32, day as u32)
}

fn validate_control_origin(value: &str) -> Result<Url, LarmControlError> {
    let mut url = Url::parse(value).map_err(|error| {
        LarmControlError::configuration(format!("invalid controlBaseUrl: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(LarmControlError::configuration(
            "controlBaseUrl must be a canonical HTTP(S) origin without credentials or path",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| LarmControlError::configuration("controlBaseUrl host is missing"))?;
    if !is_allowed_local_host(host) {
        return Err(LarmControlError::configuration(
            "controlBaseUrl host must be loopback, private, link-local, localhost, or .local",
        ));
    }
    url.set_path("/");
    Ok(url)
}

fn is_allowed_local_host(host: &str) -> bool {
    let normalized = normalize_host(host);
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
    {
        return true;
    }
    match normalized.parse::<IpAddr>() {
        Ok(IpAddr::V4(address)) => {
            address.is_loopback() || address.is_private() || address.is_link_local()
        }
        Ok(IpAddr::V6(address)) => {
            address.is_loopback() || address.is_unique_local() || address.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn validate_claimed_provider_url(
    provider: &LarmClaimProvider,
    control_origin: &Url,
) -> Result<Url, LarmControlError> {
    let url = Url::parse(&provider.base_url).map_err(|error| {
        LarmControlError::protocol(format!("invalid claimed base URL: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/v1"
    {
        return Err(LarmControlError::protocol(
            "claimed provider base URL must be a canonical HTTP(S) /v1 URL",
        ));
    }
    let claimed_host = url.host_str().unwrap_or_default();
    let control_host = control_origin.host_str().unwrap_or_default();
    if !is_allowed_local_host(claimed_host)
        || normalize_host(claimed_host) != normalize_host(control_host)
    {
        return Err(LarmControlError::protocol(
            "claimed provider host must exactly match the allowed LARM control host",
        ));
    }
    let expected_port = url.port_or_known_default().ok_or_else(|| {
        LarmControlError::protocol("claimed provider base URL has no effective port")
    })?;
    if provider.scheme != url.scheme()
        || normalize_host(&provider.host) != normalize_host(claimed_host)
        || provider.port != expected_port
    {
        return Err(LarmControlError::protocol(
            "claimed provider scheme, host, or port does not match base URL",
        ));
    }
    Ok(url)
}

fn normalize_host(host: &str) -> String {
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn validate_claimed_health_url(
    provider: &LarmClaimProvider,
    base_url: &Url,
    connection_id: &str,
) -> Result<(), LarmControlError> {
    let health = Url::parse(&provider.health.url)
        .map_err(|error| LarmControlError::protocol(format!("invalid health URL: {error}")))?;
    let expected_path = format!(
        "/v1/agent-connections/{}/providers/{}/health",
        encode_segment(connection_id),
        encode_segment(&provider.name)
    );
    if health.origin() != base_url.origin()
        || health.path() != expected_path
        || !health.username().is_empty()
        || health.password().is_some()
        || health.query().is_some()
        || health.fragment().is_some()
    {
        return Err(LarmControlError::protocol(
            "claimed provider health URL does not match the connection and provider",
        ));
    }
    Ok(())
}

fn validate_identifier(label: &str, value: &str) -> Result<(), LarmControlError> {
    if !is_valid_identifier(value) {
        return Err(LarmControlError::configuration(format!(
            "{label} is not a valid LARM identifier"
        )));
    }
    Ok(())
}

fn is_valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.len() <= 192
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_bounded_nonempty(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn validate_idempotency_key(value: &str) -> Result<(), LarmControlError> {
    if value.is_empty()
        || value.len() > 128
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
    {
        return Err(LarmControlError::configuration(
            "idempotency key does not satisfy the LARM contract",
        ));
    }
    Ok(())
}

fn encode_segment(value: &str) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

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
        assert!(
            LarmConnectionConfig::from_settings(&malformed, "contextstill-background").is_err()
        );

        let unsafe_config = config("https://example.com");
        assert!(unsafe_config.validate().is_err());
        assert!(config("http://gnosis.local:9810").validate().is_ok());
        assert!(config("http://127.0.0.1:9810").validate().is_ok());
        let mut path_segment_config = config("http://127.0.0.1:9810");
        path_segment_config.agent_profile = "..".to_string();
        assert!(path_segment_config.validate().is_err());
    }

    #[test]
    fn client_runs_availability_create_claim_renew_and_release_without_leaking_token() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let (requests_tx, requests_rx) = mpsc::channel::<String>();
        let server_origin = origin.clone();
        let server = thread::spawn(move || {
            let connection_json = connection_json();
            let claim_json = claim_json(&server_origin);
            let responses = vec![
                json_response(
                    200,
                    serde_json::json!({
                        "contractVersion": AVAILABILITY_CONTRACT,
                        "agentProfile": "contextstill-background",
                        "audience": "saaa-desktop",
                        "state": "available",
                        "reasonCode": "available",
                        "observedAt": current_rfc3339_for_test(),
                        "validForMs": 60_000,
                        "retryAfterMs": 0,
                        "reservationGuaranteed": false,
                        "catalogRevision": "catalog-1",
                        "bootEpoch": "epoch-1"
                    }),
                ),
                json_response(201, connection_json.clone()),
                json_response(200, claim_json),
                json_response(200, connection_json),
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                requests_tx.send(request).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });

        let client = LarmControlClient::new(config(&origin)).unwrap();
        let availability = client.availability(None).unwrap();
        assert_eq!(availability.state, AvailabilityState::Available);
        let created = client.create("contextstill:create:test-1").unwrap();
        assert_eq!(created.status, LarmConnectionStatus::Ready);
        let target = client.claim(&created).unwrap();
        assert_eq!(target.api_base_url, format!("{origin}/v1"));
        assert_eq!(target.model, "contextstill-background");
        assert!(!format!("{target:?}").contains("secret-token"));
        let renewed = client
            .renew(&created.id, "contextstill:renew:test-1")
            .unwrap();
        assert_eq!(renewed.id, created.id);
        client.release(&created.id).unwrap();
        server.join().unwrap();

        let requests = requests_rx.try_iter().collect::<Vec<_>>();
        assert!(requests[0].starts_with(
            "GET /v2/agent-profiles/contextstill-background/availability?audience=saaa-desktop"
        ));
        assert!(requests[1].contains("POST /v1/agent-connections HTTP/1.1"));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("idempotency-key: contextstill:create:test-1"));
        assert!(requests[1].contains("\"allowFallback\":false"));
        assert!(requests[1].contains("\"deploymentPolicy\":\"existing-only\""));
        assert!(requests[2].contains("/claim HTTP/1.1"));
        assert!(requests[3].contains("/renew HTTP/1.1"));
        assert!(requests[4].starts_with("DELETE /v1/agent-connections/"));
    }

    #[test]
    fn availability_fails_closed_on_contract_or_reservation_mismatch() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            let response = json_response(
                200,
                serde_json::json!({
                    "contractVersion": AVAILABILITY_CONTRACT,
                    "agentProfile": "contextstill-background",
                    "audience": "saaa-desktop",
                    "state": "available",
                    "reasonCode": "available",
                    "observedAt": current_rfc3339_for_test(),
                    "validForMs": 1000,
                    "retryAfterMs": 0,
                    "reservationGuaranteed": true,
                    "catalogRevision": "catalog-1",
                    "bootEpoch": "epoch-1"
                }),
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let error = LarmControlClient::new(config(&format!("http://{address}")))
            .unwrap()
            .availability(None)
            .unwrap_err();
        assert_eq!(error.kind, "protocol");
        assert!(!error.retryable);
        server.join().unwrap();
    }

    #[test]
    fn availability_rejects_stale_observations() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            let response = json_response(
                200,
                serde_json::json!({
                    "contractVersion": AVAILABILITY_CONTRACT,
                    "agentProfile": "contextstill-background",
                    "audience": "saaa-desktop",
                    "state": "available",
                    "reasonCode": "available",
                    "observedAt": "2020-01-01T00:00:00.000Z",
                    "validForMs": 60_000,
                    "retryAfterMs": 0,
                    "reservationGuaranteed": false,
                    "catalogRevision": "catalog-1",
                    "bootEpoch": "epoch-1"
                }),
            );
            stream.write_all(response.as_bytes()).unwrap();
        });

        let error = LarmControlClient::new(config(&format!("http://{address}")))
            .unwrap()
            .availability(None)
            .unwrap_err();

        assert_eq!(error.kind, "protocol");
        assert!(error.message.contains("expired"));
        server.join().unwrap();
    }

    #[test]
    fn availability_preserves_retryable_http_error_classification() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            stream
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });

        let error = LarmControlClient::new(config(&format!("http://{address}")))
            .unwrap()
            .availability(None)
            .unwrap_err();

        assert_eq!(error.kind, "http");
        assert_eq!(error.http_status, Some(503));
        assert!(error.retryable);
        server.join().unwrap();
    }

    #[test]
    fn create_accepts_an_asynchronous_202_connection_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut pending = connection_json();
        pending["status"] = Value::String("pending".to_string());
        pending["providers"][0]["readiness"] = Value::String("pending".to_string());
        pending["providers"][0]["claimable"] = Value::Bool(false);
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            stream
                .write_all(json_response(202, pending).as_bytes())
                .unwrap();
        });

        let created = LarmControlClient::new(config(&format!("http://{address}")))
            .unwrap()
            .create("contextstill:create:async-test")
            .unwrap();

        assert_eq!(created.status, LarmConnectionStatus::Pending);
        server.join().unwrap();
    }

    #[test]
    fn claim_accepts_a_validated_dynamic_port_on_the_control_host() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let control_origin = format!("http://{address}");
        let provider_port = if address.port() == u16::MAX {
            address.port() - 1
        } else {
            address.port() + 1
        };
        let provider_origin = format!("http://127.0.0.1:{provider_port}");
        let response_origin = provider_origin.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            let response = json_response(200, claim_json(&response_origin));
            stream.write_all(response.as_bytes()).unwrap();
        });

        let client = LarmControlClient::new(config(&control_origin)).unwrap();
        let connection = serde_json::from_value::<PublicLarmConnection>(connection_json()).unwrap();
        let target = client.claim(&connection).unwrap();

        assert_eq!(target.api_base_url, format!("{provider_origin}/v1"));
        server.join().unwrap();
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
    fn readiness_poll_rejects_connection_identity_changes() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut initial_json = connection_json();
        initial_json["status"] = Value::String("pending".to_string());
        initial_json["providers"][0]["readiness"] = Value::String("pending".to_string());
        initial_json["providers"][0]["claimable"] = Value::Bool(false);
        let initial = serde_json::from_value::<PublicLarmConnection>(initial_json).unwrap();
        let mut changed_json = connection_json();
        changed_json["allocationId"] = Value::String("alloc-replaced".to_string());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = read_request(&mut stream);
            let response = json_response(200, changed_json);
            stream.write_all(response.as_bytes()).unwrap();
        });

        let error = LarmControlClient::new(config(&format!("http://{address}")))
            .unwrap()
            .wait_until_ready(initial)
            .unwrap_err();

        assert_eq!(error.kind, "protocol");
        assert!(error.message.contains("identity changed"));
        server.join().unwrap();
    }

    #[test]
    fn target_renewal_is_required_before_request_lifetime_becomes_too_short() {
        let client = LarmControlClient::new(config("http://127.0.0.1:9")).unwrap();
        let target = |expires_at| ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: "http://127.0.0.1:9/v1".to_string(),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("secret-token".to_string()),
            expires_at,
        };
        let short = target(rfc3339_for_test(now_epoch_ms() + 1_000));
        let sufficient = target(rfc3339_for_test(
            now_epoch_ms() + 300_000 + REQUEST_CLEANUP_MARGIN_MS + 10_000,
        ));

        assert!(client.target_requires_renewal(&short).unwrap());
        assert!(!client.target_requires_renewal(&sufficient).unwrap());
    }

    #[test]
    fn timestamp_parser_rejects_noncanonical_and_invalid_dates() {
        assert_eq!(parse_rfc3339_utc_ms("2026-02-29T12:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc_ms("2026-9-06T12:00:00Z"), None);
        assert_eq!(parse_rfc3339_utc_ms("2026-09-06T1:00:00Z"), None);
        assert!(parse_rfc3339_utc_ms("2024-02-29T12:00:00.123Z").is_some());
    }

    fn config(origin: &str) -> LarmConnectionConfig {
        LarmConnectionConfig {
            id: "contextstill-background".to_string(),
            control_base_url: origin.to_string(),
            agent_profile: "contextstill-background".to_string(),
            audience: "saaa-desktop".to_string(),
            availability_poll_ms: 5_000,
            availability_timeout_ms: 2_000,
            control_timeout_ms: 5_000,
            ready_timeout_ms: 180_000,
            ttl_seconds: 900,
            request_timeout_ms: 300_000,
        }
    }

    fn connection_json() -> Value {
        serde_json::json!({
            "id": "aconn_epoch_1",
            "allocationId": "alloc_epoch_1",
            "bootEpoch": "epoch-1",
            "catalogRevision": "catalog-1",
            "agentProfile": "contextstill-background",
            "profileRevision": "1".repeat(64),
            "audience": "saaa-desktop",
            "audienceRevision": "2".repeat(64),
            "status": "ready",
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "route": "llm-agent-worker",
                "protocol": OPENAI_PROTOCOL,
                "publicModel": "contextstill-background",
                "readiness": "ready",
                "claimable": true
            }],
            "createdAt": "2026-09-06T12:00:00.000Z",
            "expiresAt": "2099-09-06T12:15:00.000Z"
        })
    }

    fn claim_json(origin: &str) -> Value {
        serde_json::json!({
            "id": "aconn_epoch_1",
            "allocationId": "alloc_epoch_1",
            "status": "ready",
            "audience": "saaa-desktop",
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "apiStyle": "openai",
                "protocol": OPENAI_PROTOCOL,
                "scheme": "http",
                "host": "127.0.0.1",
                "port": Url::parse(origin).unwrap().port().unwrap(),
                "baseUrl": format!("{origin}/v1"),
                "model": "contextstill-background",
                "health": {
                    "url": format!("{origin}/v1/agent-connections/aconn_epoch_1/providers/llm/health"),
                    "kind": "semantic-inference",
                    "maxAgeMs": 10000
                },
                "credential": {
                    "type": "bearer",
                    "token": "secret-token",
                    "expiresAt": "2099-09-06T12:15:00.000Z"
                },
                "configuration": {
                    "kind": AGENT_CONNECTION_CONTRACT,
                    "fields": {
                        "baseURL": format!("{origin}/v1"),
                        "model": "contextstill-background"
                    },
                    "secretFields": { "apiKey": "credential.token" }
                }
            }],
            "expiresAt": "2099-09-06T12:15:00.000Z"
        })
    }

    fn json_response(status: u16, body: Value) -> String {
        let body = body.to_string();
        let reason = match status {
            200 => "OK",
            201 => "Created",
            202 => "Accepted",
            _ => "Unknown",
        };
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request = String::new();
        let mut content_length = 0_usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line.is_empty() || line == "\r\n" {
                break;
            }
            if let Some(value) = line
                .to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|value| value.trim().parse::<usize>().ok())
            {
                content_length = value;
            }
            request.push_str(&line);
        }
        if content_length > 0 {
            let mut body = vec![0_u8; content_length];
            reader.read_exact(&mut body).unwrap();
            request.push_str(&String::from_utf8(body).unwrap());
        }
        request
    }
}
