use super::super::*;
use super::{config, json_response, read_request};
use std::io::Write;
use std::net::TcpListener;
use std::sync::mpsc;

#[test]
fn service_activity_fails_closed_on_contract_reservation_and_count_mismatch() {
    let client = LarmControlClient::new(config("http://127.0.0.1:9")).unwrap();
    let mut activity = LarmServiceActivity {
        contract_version: "wrong-contract".to_string(),
        state: ServiceActivityState::Idle,
        active_workloads: 0,
        observed_at: current_rfc3339_for_test(),
        valid_for_ms: 1_000,
        retry_after_ms: 0,
        reservation_guaranteed: false,
        boot_epoch: "epoch-1".to_string(),
        config_revision: "catalog-1".to_string(),
    };
    assert!(client.validate_service_activity(&activity).is_err());
    activity.contract_version = SERVICE_ACTIVITY_CONTRACT.to_string();
    activity.reservation_guaranteed = true;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.reservation_guaranteed = false;
    activity.active_workloads = 1;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.state = ServiceActivityState::Active;
    activity.active_workloads = 0;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.state = ServiceActivityState::Idle;
    activity.observed_at = "2099-09-06T12:34:56.789Z".to_string();
    assert!(client.validate_service_activity(&activity).is_err());
    activity.observed_at = current_rfc3339_for_test();
    activity.valid_for_ms = 999;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.valid_for_ms = 1_001;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.valid_for_ms = 1_000;
    activity.retry_after_ms = 1;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.state = ServiceActivityState::Active;
    activity.active_workloads = 1;
    activity.retry_after_ms = 999;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.retry_after_ms = 1_001;
    assert!(client.validate_service_activity(&activity).is_err());
    activity.retry_after_ms = 1_000;
    assert!(client.validate_service_activity(&activity).is_ok());

    let mut unknown = serde_json::to_value(activity).unwrap();
    unknown["unexpected"] = serde_json::Value::Bool(true);
    assert!(serde_json::from_value::<LarmServiceActivity>(unknown).is_err());
}

#[test]
fn service_activity_rejects_reservation_claim_from_http_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        let response = json_response(
            200,
            serde_json::json!({
                "contractVersion": SERVICE_ACTIVITY_CONTRACT,
                "state": "idle",
                "activeWorkloads": 0,
                "observedAt": current_rfc3339_for_test(),
                "validForMs": 1000,
                "retryAfterMs": 0,
                "reservationGuaranteed": true,
                "bootEpoch": "epoch-1",
                "configRevision": "catalog-1"
            }),
        );
        stream.write_all(response.as_bytes()).unwrap();
    });
    let error = LarmControlClient::new(config(&format!("http://{address}")))
        .unwrap()
        .service_activity()
        .unwrap_err();
    assert_eq!(error.kind, "protocol");
    assert!(!error.retryable);
    server.join().unwrap();
}

#[test]
fn service_activity_rejects_stale_observations() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        let response = json_response(
            200,
            serde_json::json!({
                "contractVersion": SERVICE_ACTIVITY_CONTRACT,
                "state": "idle",
                "activeWorkloads": 0,
                "observedAt": "2020-01-01T00:00:00.000Z",
                "validForMs": 1_000,
                "retryAfterMs": 0,
                "reservationGuaranteed": false,
                "bootEpoch": "epoch-1",
                "configRevision": "catalog-1"
            }),
        );
        stream.write_all(response.as_bytes()).unwrap();
    });

    let error = LarmControlClient::new(config(&format!("http://{address}")))
        .unwrap()
        .service_activity()
        .unwrap_err();

    assert_eq!(error.kind, "protocol");
    assert!(error.message.contains("expired"));
    server.join().unwrap();
}

#[test]
fn service_activity_preserves_retryable_http_error_classification() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
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
        .service_activity()
        .unwrap_err();

    assert_eq!(error.kind, "http");
    assert_eq!(error.http_status, Some(503));
    assert!(error.retryable);
    server.join().unwrap();
}

#[test]
fn service_activity_sends_bearer_only_when_configured() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (requests_tx, requests_rx) = mpsc::channel();
    let server = std::thread::spawn(move || {
        for _ in 0..2 {
            let (mut stream, _) = listener.accept().unwrap();
            requests_tx.send(read_request(&mut stream)).unwrap();
            let response = json_response(
                200,
                serde_json::json!({
                    "contractVersion": SERVICE_ACTIVITY_CONTRACT,
                    "state": "idle",
                    "activeWorkloads": 0,
                    "observedAt": current_rfc3339_for_test(),
                    "validForMs": 1000,
                    "retryAfterMs": 0,
                    "reservationGuaranteed": false,
                    "bootEpoch": "epoch-1",
                    "configRevision": "catalog-1"
                }),
            );
            stream.write_all(response.as_bytes()).unwrap();
        }
    });

    LarmControlClient::new(config(&format!("http://{address}")))
        .unwrap()
        .service_activity()
        .unwrap();
    let mut authenticated = config(&format!("http://{address}"));
    authenticated.control_bearer_token = Some(Zeroizing::new("activity-secret".to_string()));
    LarmControlClient::new(authenticated)
        .unwrap()
        .service_activity()
        .unwrap();

    server.join().unwrap();
    let requests = requests_rx.try_iter().collect::<Vec<_>>();
    assert!(requests.iter().all(|request| request
        .to_ascii_lowercase()
        .contains("accept: application/json")));
    assert!(requests.iter().all(|request| request
        .to_ascii_lowercase()
        .contains("cache-control: no-cache")));
    assert!(!requests[0].to_ascii_lowercase().contains("authorization:"));
    assert!(requests[1]
        .to_ascii_lowercase()
        .contains("authorization: bearer activity-secret"));
}

#[test]
fn service_activity_treats_unauthorized_as_fail_closed() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
    });

    let error = LarmControlClient::new(config(&format!("http://{address}")))
        .unwrap()
        .service_activity()
        .unwrap_err();

    assert_eq!(error.kind, "http");
    assert_eq!(error.http_status, Some(401));
    assert!(!error.retryable);
    server.join().unwrap();
}

#[test]
fn service_activity_treats_not_found_as_fail_closed() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let _ = read_request(&mut stream);
        stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .unwrap();
    });

    let error = LarmControlClient::new(config(&format!("http://{address}")))
        .unwrap()
        .service_activity()
        .unwrap_err();

    assert_eq!(error.kind, "http");
    assert_eq!(error.http_status, Some(404));
    assert!(!error.retryable);
    server.join().unwrap();
}
