use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::shared::{config::EnvProvider, errors::CliError};

use super::service::McpSession;

pub(crate) type SharedServerState = Arc<Mutex<ServerState>>;

fn lock_state(state: &SharedServerState) -> MutexGuard<'_, ServerState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Debug)]
pub(crate) enum CreateSessionError {
    Capacity,
    Entropy,
    Persistence,
}

#[derive(Debug, Clone)]
pub(crate) struct SessionPruneConfig {
    idle_ttl_seconds: u64,
    closed_ttl_seconds: u64,
    prune_interval_seconds: u64,
}

impl SessionPruneConfig {
    pub(crate) fn from_env<E: EnvProvider>(env: &E) -> Self {
        Self {
            idle_ttl_seconds: env_u64_default(
                env,
                "CONTEXT_STILL_MCP_SESSION_IDLE_TTL_SECONDS",
                60,
            ),
            closed_ttl_seconds: env_u64_default(
                env,
                "CONTEXT_STILL_MCP_CLOSED_SESSION_TTL_SECONDS",
                0,
            ),
            prune_interval_seconds: env_u64_default(
                env,
                "CONTEXT_STILL_MCP_SESSION_PRUNE_INTERVAL_SECONDS",
                10,
            ),
        }
    }

    pub(crate) fn typed_memory() -> Self {
        Self {
            idle_ttl_seconds: 60,
            closed_ttl_seconds: 0,
            prune_interval_seconds: 10,
        }
    }
}

#[derive(Debug)]
pub(crate) struct ServerState {
    sessions: Vec<McpSession>,
    sessions_path: PathBuf,
    prune_config: SessionPruneConfig,
    last_pruned_unix_seconds: u64,
    minimal_ledger: bool,
}

pub(crate) fn new_state(
    sessions_path: PathBuf,
    prune_config: SessionPruneConfig,
    minimal_ledger: bool,
) -> SharedServerState {
    Arc::new(Mutex::new(ServerState {
        sessions: Vec::new(),
        sessions_path,
        prune_config,
        last_pruned_unix_seconds: 0,
        minimal_ledger,
    }))
}

pub(crate) fn persist_sessions(state: &SharedServerState) -> Result<(), CliError> {
    let state = lock_state(state);
    let content = if state.minimal_ledger {
        let sessions = state
            .sessions
            .iter()
            .map(|session| {
                json!({
                    "sessionId":session.session_id,
                    "createdAt":session.created_at,
                    "lastActivityAt":session.last_activity_at,
                    "lastActivityUnixSeconds":session.last_activity_unix_seconds,
                    "inFlightRequestCount":session.in_flight_request_count,
                    "closeReason":session.close_reason
                })
            })
            .collect::<Vec<_>>();
        serde_json::to_string_pretty(&sessions)
    } else {
        serde_json::to_string_pretty(&state.sessions)
    }
    .map_err(|error| CliError::io(format!("failed to serialize MCP sessions: {error}")))?;
    if state.minimal_ledger {
        super::memory_profile_auth::write_owner_only(
            &state.sessions_path,
            &format!("{content}\n"),
            "typed-memory sessions",
        )?;
    } else {
        std::fs::write(&state.sessions_path, format!("{content}\n"))
            .map_err(|error| CliError::io(format!("failed to write MCP sessions: {error}")))?;
    }
    Ok(())
}

pub(crate) fn create_session(
    state: &SharedServerState,
    body: &Value,
    remote: Option<String>,
    max_active: Option<usize>,
) -> Result<String, CreateSessionError> {
    prune_sessions(state, true);
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| CreateSessionError::Entropy)?;
    let session_id = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let now = now_timestamp();
    let now_unix = now_unix_seconds();
    let client_info = body
        .get("params")
        .and_then(|params| params.get("clientInfo"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let session = McpSession {
        session_id: session_id.clone(),
        client_name: client_info
            .get("name")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        client_version: client_info
            .get("version")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        remote_address: remote,
        created_at: now.clone(),
        last_activity_at: now,
        last_activity_unix_seconds: Some(now_unix),
        in_flight_request_count: 0,
        worker_id: Some(format!("rust-mcp-worker-{}", std::process::id())),
        route: "rust-mcp-server".to_string(),
        close_reason: None,
        initialized: false,
    };
    let mut state_guard = lock_state(state);
    if max_active.is_some_and(|max| {
        state_guard
            .sessions
            .iter()
            .filter(|session| session.close_reason.is_none())
            .count()
            >= max
    }) {
        return Err(CreateSessionError::Capacity);
    }
    state_guard.sessions.push(session);
    drop(state_guard);
    if persist_sessions(state).is_err() {
        lock_state(state)
            .sessions
            .retain(|session| session.session_id != session_id);
        return Err(CreateSessionError::Persistence);
    }
    Ok(session_id)
}

pub(crate) fn is_initialized(state: &SharedServerState, session_id: &str) -> bool {
    lock_state(state)
        .sessions
        .iter()
        .find(|session| session.session_id == session_id && session.close_reason.is_none())
        .is_some_and(|session| session.initialized)
}

pub(crate) fn mark_initialized(state: &SharedServerState, session_id: &str) -> bool {
    let mut state = lock_state(state);
    let Some(session) = state
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id && session.close_reason.is_none())
    else {
        return false;
    };
    session.initialized = true;
    true
}

pub(crate) fn active_session_count(state: &SharedServerState) -> usize {
    lock_state(state)
        .sessions
        .iter()
        .filter(|session| session.close_reason.is_none())
        .count()
}

pub(crate) fn is_active_session(state: &SharedServerState, session_id: &str) -> bool {
    prune_sessions(state, true);
    lock_state(state)
        .sessions
        .iter()
        .any(|session| session.session_id == session_id && session.close_reason.is_none())
}

pub(crate) fn touch_session(state: &SharedServerState, session_id: &str, delta: i32) {
    let now = now_timestamp();
    let now_unix = now_unix_seconds();
    if let Some(session) = lock_state(state)
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id)
    {
        session.last_activity_at = now;
        session.last_activity_unix_seconds = Some(now_unix);
        session.in_flight_request_count =
            (session.in_flight_request_count as i32 + delta).max(0) as u32;
    }
    let _ = persist_sessions(state);
}

pub(crate) fn close_session(state: &SharedServerState, session_id: &str) -> bool {
    let now = now_timestamp();
    let now_unix = now_unix_seconds();
    let mut state_guard = lock_state(state);
    let Some(session) = state_guard
        .sessions
        .iter_mut()
        .find(|session| session.session_id == session_id && session.close_reason.is_none())
    else {
        return false;
    };
    session.close_reason = Some("client_disconnect".to_string());
    session.last_activity_at = now;
    session.last_activity_unix_seconds = Some(now_unix);
    session.in_flight_request_count = 0;
    drop(state_guard);
    let _ = persist_sessions(state);
    true
}

pub(crate) fn prune_sessions(state: &SharedServerState, force: bool) {
    let now = now_unix_seconds();
    let mut state_guard = lock_state(state);
    if !force
        && state_guard.last_pruned_unix_seconds > 0
        && now.saturating_sub(state_guard.last_pruned_unix_seconds)
            < state_guard.prune_config.prune_interval_seconds
    {
        return;
    }

    state_guard.last_pruned_unix_seconds = now;
    let before = state_guard.sessions.len();
    let config = state_guard.prune_config.clone();
    state_guard.sessions.retain(|session| {
        let age = now.saturating_sub(session.last_activity_unix_seconds.unwrap_or(now));
        if session.close_reason.is_some() {
            return config.closed_ttl_seconds > 0 && age <= config.closed_ttl_seconds;
        }
        session.in_flight_request_count > 0 || age <= config.idle_ttl_seconds
    });
    let changed = state_guard.sessions.len() != before;
    drop(state_guard);

    if changed {
        let _ = persist_sessions(state);
    }
}

pub(crate) fn now_timestamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix-ms:{millis}")
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn env_u64_default<E: EnvProvider>(env: &E, key: &str, default: u64) -> u64 {
    env.var(key)
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    fn temp_sessions_path() -> PathBuf {
        let temp_id = NEXT_TEMP_ID.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "context_still_mcp_sessions_{}_{}.json",
            std::process::id(),
            temp_id
        ))
    }

    fn prune_config() -> SessionPruneConfig {
        SessionPruneConfig {
            idle_ttl_seconds: 1,
            closed_ttl_seconds: 0,
            prune_interval_seconds: 30,
        }
    }

    #[test]
    fn closed_sessions_are_pruned_immediately_by_default() {
        let sessions_path = temp_sessions_path();
        let state = new_state(sessions_path.clone(), prune_config(), false);
        let session_id = create_session(&state, &json!({}), None, None).unwrap();

        assert!(close_session(&state, &session_id));
        prune_sessions(&state, true);

        assert_eq!(active_session_count(&state), 0);
        assert!(state.lock().unwrap().sessions.is_empty());
        let _ = std::fs::remove_file(sessions_path);
    }

    #[test]
    fn idle_sessions_are_pruned_after_ttl() {
        let sessions_path = temp_sessions_path();
        let state = new_state(sessions_path.clone(), prune_config(), false);
        let session_id = create_session(&state, &json!({}), None, None).unwrap();
        {
            let mut state_guard = state.lock().unwrap();
            let session = state_guard
                .sessions
                .iter_mut()
                .find(|session| session.session_id == session_id)
                .unwrap();
            session.last_activity_unix_seconds = Some(1);
        }

        prune_sessions(&state, true);

        assert_eq!(active_session_count(&state), 0);
        assert!(state.lock().unwrap().sessions.is_empty());
        let _ = std::fs::remove_file(sessions_path);
    }

    #[test]
    fn active_session_check_enforces_ttl_even_inside_prune_interval() {
        let sessions_path = temp_sessions_path();
        let state = new_state(sessions_path.clone(), prune_config(), false);
        let session_id = create_session(&state, &json!({}), None, None).unwrap();
        {
            let mut state_guard = state.lock().unwrap();
            state_guard.last_pruned_unix_seconds = now_unix_seconds();
            state_guard.sessions[0].last_activity_unix_seconds = Some(1);
        }

        assert!(!is_active_session(&state, &session_id));
        assert!(state.lock().unwrap().sessions.is_empty());
        let _ = std::fs::remove_file(sessions_path);
    }
}
