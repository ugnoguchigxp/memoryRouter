use std::time::{Duration, Instant};

use super::service::{
    ensure_same_connection_identity, ClaimedLarmTarget, LarmConnectionConfig, LarmConnectionStatus,
    LarmControlClient, LarmControlError, LarmServiceActivity, PublicLarmConnection,
    ServiceActivityState,
};

const TRANSIENT_BACKOFF_MAX_MS: u64 = 60_000;
const UNAVAILABLE_BACKOFF_MS: u64 = 300_000;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum LarmConnectionManagerState {
    WaitingActivity,
    Creating,
    WaitingReady,
    Claiming,
    Ready,
    Renewing,
    Releasing,
    Backoff,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LarmReconcileResult {
    pub state: LarmConnectionManagerState,
    pub ready: bool,
    pub reason_code: Option<String>,
    pub retry_after_ms: u64,
}

#[derive(Debug)]
pub struct LarmConnectionManager {
    client: LarmControlClient,
    state: LarmConnectionManagerState,
    connection: Option<PublicLarmConnection>,
    target: Option<ClaimedLarmTarget>,
    next_poll_at: Option<Instant>,
    transient_backoff_ms: u64,
    pending_create_key: Option<String>,
}

impl LarmConnectionManager {
    pub fn new(config: LarmConnectionConfig) -> Result<Self, LarmControlError> {
        Ok(Self {
            client: LarmControlClient::new(config)?,
            state: LarmConnectionManagerState::WaitingActivity,
            connection: None,
            target: None,
            next_poll_at: None,
            transient_backoff_ms: 0,
            pending_create_key: None,
        })
    }

    pub fn state(&self) -> LarmConnectionManagerState {
        self.state
    }

    pub fn config(&self) -> &LarmConnectionConfig {
        self.client.config()
    }

    pub fn target(&self) -> Option<&ClaimedLarmTarget> {
        self.target.as_ref()
    }

    pub fn connection_id(&self) -> Option<&str> {
        self.connection
            .as_ref()
            .map(|connection| connection.id.as_str())
    }

    pub fn reconcile(
        &mut self,
        due_job_exists: bool,
    ) -> Result<LarmReconcileResult, LarmControlError> {
        if !due_job_exists {
            self.release()?;
            return Ok(self.waiting_result("queue_idle", 0));
        }
        if let Some(next_poll_at) = self.next_poll_at {
            if Instant::now() < next_poll_at {
                return Ok(LarmReconcileResult {
                    state: self.state,
                    ready: false,
                    reason_code: Some("backoff".to_string()),
                    retry_after_ms: next_poll_at
                        .saturating_duration_since(Instant::now())
                        .as_millis()
                        .try_into()
                        .unwrap_or(u64::MAX),
                });
            }
            self.next_poll_at = None;
        }

        self.state = LarmConnectionManagerState::WaitingActivity;
        let activity = match self.client.service_activity() {
            Ok(activity) => activity,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        match activity.state {
            ServiceActivityState::Idle => {}
            ServiceActivityState::Active => {
                self.release()?;
                let retry_after_ms = self.schedule_poll(activity.retry_after_ms, false);
                return Ok(self.waiting_result("service_active", retry_after_ms));
            }
            ServiceActivityState::Draining => {
                self.release()?;
                let retry_after_ms = self.schedule_poll(activity.retry_after_ms, false);
                return Ok(self.waiting_result("service_draining", retry_after_ms));
            }
        }

        self.transient_backoff_ms = 0;
        self.next_poll_at = None;
        if self.connection.as_ref().is_some_and(|connection| {
            connection.boot_epoch != activity.boot_epoch
                || connection.catalog_revision != activity.config_revision
        }) {
            self.discard_connection_best_effort();
        }
        if let Some(target) = self.target.as_ref() {
            let requires_renewal = match self.client.target_requires_renewal(target) {
                Ok(requires_renewal) => requires_renewal,
                Err(error) => {
                    self.fail_closed(&error);
                    return Err(error);
                }
            };
            if requires_renewal {
                self.renew_and_reclaim()?;
            }
        }
        if self.target.is_none() {
            if let Err(error) = self.acquire_target(&activity) {
                self.fail_closed(&error);
                return Err(error);
            }
        }
        self.state = LarmConnectionManagerState::Ready;
        Ok(LarmReconcileResult {
            state: self.state,
            ready: true,
            reason_code: Some("service_idle".to_string()),
            retry_after_ms: 0,
        })
    }

    pub fn renew_and_reclaim(&mut self) -> Result<(), LarmControlError> {
        let connection_id = self
            .connection_id()
            .map(str::to_string)
            .ok_or_else(|| LarmControlError::configuration("no LARM connection to renew"))?;
        self.target = None;
        self.state = LarmConnectionManagerState::Renewing;
        let key = match self.client.new_idempotency_key("renew") {
            Ok(key) => key,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        let renewed = match self.client.renew(&connection_id, &key) {
            Ok(connection) => connection,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        if let Some(previous) = self.connection.as_ref() {
            if let Err(error) = ensure_same_connection_identity(previous, &renewed) {
                self.fail_closed(&error);
                return Err(error);
            }
        }
        self.connection = Some(renewed.clone());
        self.state = LarmConnectionManagerState::WaitingReady;
        let ready = match self.client.wait_until_ready(renewed) {
            Ok(connection) => connection,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        self.state = LarmConnectionManagerState::Claiming;
        let target = match self.client.claim(&ready) {
            Ok(target) => target,
            Err(error) => {
                self.fail_closed(&error);
                return Err(error);
            }
        };
        self.connection = Some(ready);
        self.target = Some(target);
        self.state = LarmConnectionManagerState::Ready;
        self.transient_backoff_ms = 0;
        self.next_poll_at = None;
        Ok(())
    }

    pub fn release(&mut self) -> Result<(), LarmControlError> {
        self.target = None;
        self.pending_create_key = None;
        let Some(connection_id) = self.connection_id().map(str::to_string) else {
            self.state = LarmConnectionManagerState::WaitingActivity;
            self.next_poll_at = None;
            self.transient_backoff_ms = 0;
            return Ok(());
        };
        self.state = LarmConnectionManagerState::Releasing;
        let result = self.client.release(&connection_id);
        // A failed remote cleanup must not leave a locally reusable Connection.
        // LARM's TTL is the final cleanup mechanism when DELETE cannot be confirmed.
        self.connection = None;
        match result {
            Ok(()) => {
                self.state = LarmConnectionManagerState::WaitingActivity;
                self.next_poll_at = None;
                self.transient_backoff_ms = 0;
                Ok(())
            }
            Err(error) => {
                self.state = LarmConnectionManagerState::Backoff;
                if error.retryable {
                    self.schedule_transient_backoff(0);
                } else {
                    self.schedule_unavailable_backoff(0);
                }
                Err(error)
            }
        }
    }

    fn acquire_target(&mut self, activity: &LarmServiceActivity) -> Result<(), LarmControlError> {
        let ready = if let Some(connection) = self.connection.clone() {
            if connection.boot_epoch != activity.boot_epoch
                || connection.catalog_revision != activity.config_revision
            {
                return Err(LarmControlError::protocol(
                    "LARM connection control-plane identity does not match service activity",
                ));
            }
            self.state = LarmConnectionManagerState::WaitingReady;
            self.client.wait_until_ready(connection)?
        } else {
            self.client
                .discover_configured_profile(&activity.config_revision)?;
            self.state = LarmConnectionManagerState::Creating;
            let key = match self.pending_create_key.clone() {
                Some(key) => key,
                None => {
                    let key = self.client.new_idempotency_key("create")?;
                    self.pending_create_key = Some(key.clone());
                    key
                }
            };
            let created = match self.client.create(&key) {
                Ok(connection) => {
                    self.pending_create_key = None;
                    connection
                }
                Err(error) => {
                    if !error.retryable || error.http_status == Some(409) {
                        self.pending_create_key = None;
                    }
                    return Err(error);
                }
            };
            self.connection = Some(created.clone());
            if created.boot_epoch != activity.boot_epoch
                || created.catalog_revision != activity.config_revision
            {
                return Err(LarmControlError::protocol(
                    "LARM control-plane identity changed between activity and create",
                ));
            }
            self.state = LarmConnectionManagerState::WaitingReady;
            self.client.wait_until_ready(created)?
        };
        if ready.status != LarmConnectionStatus::Ready {
            return Err(LarmControlError::protocol(
                "LARM connection was not ready after readiness polling",
            ));
        }
        self.connection = Some(ready.clone());
        self.state = LarmConnectionManagerState::Claiming;
        self.target = Some(self.client.claim(&ready)?);
        Ok(())
    }

    fn discard_connection_best_effort(&mut self) {
        self.target = None;
        self.pending_create_key = None;
        if let Some(connection_id) = self.connection_id().map(str::to_string) {
            self.state = LarmConnectionManagerState::Releasing;
            let _ = self.client.release(&connection_id);
        }
        self.connection = None;
        self.state = LarmConnectionManagerState::WaitingActivity;
    }

    fn fail_closed(&mut self, error: &LarmControlError) {
        self.target = None;
        if let Some(connection_id) = self.connection_id().map(str::to_string) {
            self.state = LarmConnectionManagerState::Releasing;
            let _ = self.client.release(&connection_id);
        }
        // A connection involved in a protocol or transport failure must never be
        // reused just because its best-effort remote cleanup also failed. LARM's
        // TTL remains the final cleanup mechanism for the remote allocation.
        self.connection = None;
        let retry_after_ms = if error.retryable {
            self.schedule_transient_backoff(0)
        } else {
            self.schedule_unavailable_backoff(0)
        };
        self.state = LarmConnectionManagerState::Backoff;
        self.set_next_poll(retry_after_ms);
    }

    fn schedule_poll(&mut self, retry_after_ms: u64, unavailable: bool) -> u64 {
        let base = if unavailable {
            UNAVAILABLE_BACKOFF_MS
        } else {
            self.client.config().availability_poll_ms
        };
        let delay = retry_after_ms
            .max(jittered_delay(base))
            .min(UNAVAILABLE_BACKOFF_MS);
        self.state = LarmConnectionManagerState::Backoff;
        self.set_next_poll(delay);
        delay
    }

    fn schedule_transient_backoff(&mut self, retry_after_ms: u64) -> u64 {
        self.transient_backoff_ms = if self.transient_backoff_ms == 0 {
            self.client.config().availability_poll_ms
        } else {
            self.transient_backoff_ms.saturating_mul(2)
        }
        .min(TRANSIENT_BACKOFF_MAX_MS);
        let delay = retry_after_ms
            .max(jittered_delay(self.transient_backoff_ms))
            .min(TRANSIENT_BACKOFF_MAX_MS);
        self.state = LarmConnectionManagerState::Backoff;
        self.set_next_poll(delay);
        delay
    }

    fn schedule_unavailable_backoff(&mut self, retry_after_ms: u64) -> u64 {
        self.schedule_poll(retry_after_ms, true)
    }

    fn waiting_result(&self, reason_code: &str, retry_after_ms: u64) -> LarmReconcileResult {
        LarmReconcileResult {
            state: self.state,
            ready: false,
            reason_code: Some(reason_code.to_string()),
            retry_after_ms,
        }
    }

    fn set_next_poll(&mut self, delay_ms: u64) {
        let now = Instant::now();
        self.next_poll_at = now
            .checked_add(Duration::from_millis(delay_ms))
            .or(Some(now));
    }
}

fn jittered_delay(base_ms: u64) -> u64 {
    let mut entropy = [0_u8; 2];
    if getrandom::fill(&mut entropy).is_err() {
        return base_ms;
    }
    let sample = u16::from_le_bytes(entropy) as u64;
    let percent = 80 + (sample % 41);
    base_ms.saturating_mul(percent) / 100
}

#[cfg(test)]
mod tests {
    use super::super::service::PublicLarmConnectionProvider;
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::thread;
    use zeroize::Zeroizing;

    #[test]
    fn queue_idle_does_not_poll_service_activity() {
        let mut manager = LarmConnectionManager::new(config("http://127.0.0.1:9")).unwrap();
        let result = manager.reconcile(false).unwrap();
        assert!(!result.ready);
        assert_eq!(result.reason_code.as_deref(), Some("queue_idle"));
        assert_eq!(manager.state(), LarmConnectionManagerState::WaitingActivity);
    }

    #[test]
    fn active_service_activity_enters_backoff_without_creating_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request_tx.send(read_request(&mut stream)).unwrap();
            let response = json_response(serde_json::json!({
                "contractVersion": "larm-service-activity.v1",
                "state": "active",
                "activeWorkloads": 1,
                "observedAt": super::super::service::current_rfc3339_for_test(),
                "validForMs": 1_000,
                "retryAfterMs": 1_000,
                "reservationGuaranteed": false,
                "bootEpoch": "epoch-1",
                "configRevision": "catalog-1"
            }));
            stream.write_all(response.as_bytes()).unwrap();
        });

        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        let result = manager.reconcile(true).unwrap();
        assert!(!result.ready);
        assert_eq!(result.reason_code.as_deref(), Some("service_active"));
        assert!(result.retry_after_ms >= 1_000);
        assert_eq!(manager.state(), LarmConnectionManagerState::Backoff);
        assert!(manager.target().is_none());
        assert!(request_rx
            .recv()
            .unwrap()
            .starts_with("GET /v1/activity HTTP/1.1"));
        server.join().unwrap();
    }

    #[test]
    fn draining_service_activity_does_not_create_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request_tx.send(read_request(&mut stream)).unwrap();
            stream
                .write_all(
                    json_response(service_activity_json(
                        "draining",
                        0,
                        1_000,
                        "epoch-1",
                        "catalog-1",
                    ))
                    .as_bytes(),
                )
                .unwrap();
        });

        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        let result = manager.reconcile(true).unwrap();

        assert!(!result.ready);
        assert_eq!(result.reason_code.as_deref(), Some("service_draining"));
        assert!(manager.target().is_none());
        assert_eq!(request_rx.try_iter().count(), 1);
        server.join().unwrap();
    }

    #[test]
    fn invalid_http_stale_and_timeout_activity_never_create_connection() {
        let mut unknown = service_activity_json("idle", 0, 0, "epoch-1", "catalog-1");
        unknown["unexpected"] = serde_json::Value::Bool(true);
        assert_activity_failure_does_not_create(Some(json_response(unknown)));
        assert_activity_failure_does_not_create(Some(
            "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        ));
        let mut stale = service_activity_json("idle", 0, 0, "epoch-1", "catalog-1");
        stale["observedAt"] = serde_json::Value::String("2020-01-01T00:00:00.000Z".to_string());
        assert_activity_failure_does_not_create(Some(json_response(stale)));
        assert_activity_failure_does_not_create(None);
    }

    #[test]
    fn missing_configured_profile_does_not_create_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut catalog = profile_catalog_json("catalog-1");
            catalog["profiles"] = serde_json::json!([]);
            for response in [
                json_response(service_activity_json("idle", 0, 0, "epoch-1", "catalog-1")),
                json_response(catalog),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();

        assert!(manager.reconcile(true).is_err());
        server.join().unwrap();

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("GET /v1/activity HTTP/1.1"));
        assert!(requests[1].starts_with("GET /v2/agent-profiles HTTP/1.1"));
    }

    #[test]
    fn next_job_boundary_rechecks_activity_and_yields_to_another_service() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let response_origin = origin.clone();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let responses = [
                json_response(service_activity_json("idle", 0, 0, "epoch-2", "catalog-2")),
                json_response(profile_catalog_json("catalog-2")),
                json_response_with_status(201, "Created", connection_json("epoch-2")),
                json_response(claim_json(&response_origin)),
                json_response(service_activity_json(
                    "active",
                    1,
                    1_000,
                    "epoch-2",
                    "catalog-2",
                )),
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();

        assert!(manager.reconcile(true).unwrap().ready);
        let next_job = manager.reconcile(true).unwrap();
        assert!(!next_job.ready);
        assert_eq!(next_job.reason_code.as_deref(), Some("service_active"));
        assert!(manager.target().is_none());

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("GET /v1/activity HTTP/1.1"))
                .count(),
            2
        );
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.starts_with("POST /v1/agent-connections HTTP/1.1"))
                .count(),
            1
        );
        assert!(requests[4].starts_with("GET /v1/activity HTTP/1.1"));
        assert!(requests[5].starts_with("DELETE /v1/agent-connections/aconn_epoch_1"));
        server.join().unwrap();
    }

    #[test]
    fn ambiguous_create_retry_reuses_the_same_idempotency_key() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            for request_index in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                if request_index % 2 == 0 {
                    stream
                        .write_all(json_response(profile_catalog_json("catalog-1")).as_bytes())
                        .unwrap();
                }
            }
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();

        let activity = idle_activity();
        assert!(manager.acquire_target(&activity).is_err());
        assert!(manager.acquire_target(&activity).is_err());
        server.join().unwrap();

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert!(requests[0].starts_with("GET /v2/agent-profiles HTTP/1.1"));
        assert!(requests[2].starts_with("GET /v2/agent-profiles HTTP/1.1"));
        let first_key = header_value(&requests[1], "idempotency-key").unwrap();
        let second_key = header_value(&requests[3], "idempotency-key").unwrap();
        assert_eq!(first_key, second_key);
    }

    #[test]
    fn existing_connection_is_not_reused_after_catalog_revision_changes() {
        let mut manager = LarmConnectionManager::new(config("http://127.0.0.1:9")).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        let mut activity = idle_activity();
        activity.config_revision = "catalog-2".to_string();

        let error = manager.acquire_target(&activity).unwrap_err();

        assert_eq!(error.kind, "protocol");
        assert!(error.message.contains("control-plane identity"));
    }

    #[test]
    fn fail_closed_discards_local_connection_even_when_remote_release_fails() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("DELETE /v1/agent-connections/aconn_epoch_1"));
            stream
                .write_all(
                    b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("http://{address}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        manager.fail_closed(&LarmControlError::protocol("invalid claim"));

        assert!(manager.connection.is_none());
        assert!(manager.target.is_none());
        assert_eq!(manager.state(), LarmConnectionManagerState::Backoff);
        server.join().unwrap();
    }

    #[test]
    fn release_failure_discards_the_local_connection_and_credential() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("DELETE /v1/agent-connections/aconn_epoch_1"));
            stream
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let mut manager = LarmConnectionManager::new(config(&format!("http://{address}"))).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("http://{address}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        let error = manager.release().unwrap_err();

        assert_eq!(error.http_status, Some(503));
        assert!(manager.connection.is_none());
        assert!(manager.target().is_none());
        assert_eq!(manager.state(), LarmConnectionManagerState::Backoff);
        server.join().unwrap();
    }

    #[test]
    fn renew_discards_the_old_token_and_reclaims() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let response_origin = origin.clone();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let mut renewed = connection_json("epoch-1");
            renewed["catalogRevision"] = serde_json::Value::String("catalog-1".to_string());
            let responses = [
                json_response(renewed),
                json_response(claim_json(&response_origin)),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("{origin}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        manager.renew_and_reclaim().unwrap();

        assert_eq!(
            manager.target().unwrap().bearer_token.as_str(),
            "new-secret"
        );
        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("/renew HTTP/1.1"));
        assert!(requests[1].contains("/claim HTTP/1.1"));
        server.join().unwrap();
    }

    #[test]
    fn boot_epoch_change_discards_the_old_claim_before_reacquiring() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let origin = format!("http://{address}");
        let (request_tx, request_rx) = mpsc::channel();
        let response_origin = origin.clone();
        let server = thread::spawn(move || {
            let responses = [
                json_response(service_activity_json("idle", 0, 0, "epoch-2", "catalog-2")),
                "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    .to_string(),
                json_response(profile_catalog_json("catalog-2")),
                json_response_with_status(201, "Created", connection_json("epoch-2")),
                json_response(claim_json(&response_origin)),
            ];
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                request_tx.send(read_request(&mut stream)).unwrap();
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let mut manager = LarmConnectionManager::new(config(&origin)).unwrap();
        manager.connection = Some(public_connection("epoch-1"));
        manager.target = Some(ClaimedLarmTarget {
            connection_id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            api_base_url: format!("{origin}/v1"),
            model: "contextstill-background".to_string(),
            bearer_token: Zeroizing::new("old-secret".to_string()),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
        });

        let result = manager.reconcile(true).unwrap();

        assert!(result.ready);
        assert_eq!(manager.connection.as_ref().unwrap().boot_epoch, "epoch-2");
        assert_eq!(
            manager.target().unwrap().bearer_token.as_str(),
            "new-secret"
        );
        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert!(requests[0].starts_with("GET /v1/activity HTTP/1.1"));
        assert!(!requests[0].contains('?'));
        assert!(requests[1].starts_with("DELETE /v1/agent-connections/aconn_epoch_1"));
        assert!(requests[2].starts_with("GET /v2/agent-profiles HTTP/1.1"));
        assert!(requests[3].starts_with("POST /v1/agent-connections"));
        assert!(requests[4].contains("/claim HTTP/1.1"));
        server.join().unwrap();
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
            control_bearer_token: None,
        }
    }

    fn idle_activity() -> super::super::service::LarmServiceActivity {
        super::super::service::LarmServiceActivity {
            contract_version: "larm-service-activity.v1".to_string(),
            state: ServiceActivityState::Idle,
            active_workloads: 0,
            observed_at: "2099-09-06T12:34:56.789Z".to_string(),
            valid_for_ms: 1_000,
            retry_after_ms: 0,
            reservation_guaranteed: false,
            boot_epoch: "epoch-1".to_string(),
            config_revision: "catalog-1".to_string(),
        }
    }

    fn json_response(body: serde_json::Value) -> String {
        json_response_with_status(200, "OK", body)
    }

    fn service_activity_json(
        state: &str,
        active_workloads: u64,
        retry_after_ms: u64,
        boot_epoch: &str,
        config_revision: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "contractVersion": "larm-service-activity.v1",
            "state": state,
            "activeWorkloads": active_workloads,
            "observedAt": super::super::service::current_rfc3339_for_test(),
            "validForMs": 1_000,
            "retryAfterMs": retry_after_ms,
            "reservationGuaranteed": false,
            "bootEpoch": boot_epoch,
            "configRevision": config_revision
        })
    }

    fn profile_catalog_json(revision: &str) -> serde_json::Value {
        serde_json::json!({
            "contractVersion": "agent-connection.v2",
            "catalogRevision": revision,
            "defaultAgentProfile": "contextstill-background",
            "profiles": [{
                "id": "contextstill-background",
                "canonicalProfile": "contextstill-background",
                "description": "ContextStill background provider",
                "selectionPolicy": "explicit-only",
                "deprecated": false,
                "providers": [{
                    "name": "llm",
                    "capability": "llm.coding",
                    "supportedCapabilities": ["llm.coding"],
                    "protocol": "openai.chat-completions.v1",
                    "model": "contextstill-background"
                }]
            }],
            "audiences": ["saaa-desktop"]
        })
    }

    fn json_response_with_status(status: u16, reason: &str, body: serde_json::Value) -> String {
        let body = body.to_string();
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn public_connection(boot_epoch: &str) -> PublicLarmConnection {
        PublicLarmConnection {
            id: "aconn_epoch_1".to_string(),
            allocation_id: "alloc_epoch_1".to_string(),
            boot_epoch: boot_epoch.to_string(),
            catalog_revision: "catalog-1".to_string(),
            agent_profile: "contextstill-background".to_string(),
            profile_revision: "1".repeat(64),
            audience: "saaa-desktop".to_string(),
            audience_revision: "2".repeat(64),
            status: LarmConnectionStatus::Ready,
            providers: vec![PublicLarmConnectionProvider {
                name: "llm".to_string(),
                capability: "llm.coding".to_string(),
                route: "llm-agent-worker".to_string(),
                protocol: "openai.chat-completions.v1".to_string(),
                public_model: "contextstill-background".to_string(),
                readiness: LarmConnectionStatus::Ready,
                claimable: true,
            }],
            created_at: "2026-09-06T12:00:00.000Z".to_string(),
            expires_at: "2099-09-06T12:15:00.000Z".to_string(),
            released_at: None,
            error: None,
        }
    }

    fn connection_json(boot_epoch: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "aconn_epoch_1",
            "allocationId": "alloc_epoch_1",
            "bootEpoch": boot_epoch,
            "catalogRevision": "catalog-2",
            "agentProfile": "contextstill-background",
            "profileRevision": "1".repeat(64),
            "audience": "saaa-desktop",
            "audienceRevision": "2".repeat(64),
            "status": "ready",
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "route": "llm-agent-worker",
                "protocol": "openai.chat-completions.v1",
                "publicModel": "contextstill-background",
                "readiness": "ready",
                "claimable": true
            }],
            "createdAt": "2026-09-06T12:00:00.000Z",
            "expiresAt": "2099-09-06T12:15:00.000Z"
        })
    }

    fn claim_json(origin: &str) -> serde_json::Value {
        serde_json::json!({
            "id": "aconn_epoch_1",
            "allocationId": "alloc_epoch_1",
            "status": "ready",
            "audience": "saaa-desktop",
            "providers": [{
                "name": "llm",
                "capability": "llm.coding",
                "apiStyle": "openai",
                "protocol": "openai.chat-completions.v1",
                "scheme": "http",
                "host": "127.0.0.1",
                "port": reqwest::Url::parse(origin).unwrap().port().unwrap(),
                "baseUrl": format!("{origin}/v1"),
                "model": "contextstill-background",
                "health": {
                    "url": format!("{origin}/v1/agent-connections/aconn_epoch_1/providers/llm/health"),
                    "kind": "semantic-inference",
                    "maxAgeMs": 10000
                },
                "credential": {
                    "type": "bearer",
                    "token": "new-secret",
                    "expiresAt": "2099-09-06T12:15:00.000Z"
                },
                "configuration": {
                    "kind": "openai-provider-v1",
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

    fn header_value<'a>(request: &'a str, name: &str) -> Option<&'a str> {
        request.lines().find_map(|line| {
            let (header_name, value) = line.split_once(':')?;
            header_name
                .eq_ignore_ascii_case(name)
                .then_some(value.trim())
        })
    }

    fn assert_activity_failure_does_not_create(response: Option<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            request_tx.send(read_request(&mut stream)).unwrap();
            if let Some(response) = response {
                stream.write_all(response.as_bytes()).unwrap();
            } else {
                thread::sleep(Duration::from_millis(350));
            }
        });
        let mut test_config = config(&format!("http://{address}"));
        test_config.availability_timeout_ms = 250;
        let mut manager = LarmConnectionManager::new(test_config).unwrap();

        assert!(manager.reconcile(true).is_err());
        server.join().unwrap();

        let requests = request_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("GET /v1/activity HTTP/1.1"));
    }
}
