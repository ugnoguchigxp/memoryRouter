use rusqlite::Connection;
use std::time::SystemTime;

use super::types::{ProviderPoolClaimConfig, ProviderQueueClaimSpec, RowTargetPreference};

pub(crate) fn temp_app_dir(name: &str) -> std::path::PathBuf {
    let rand_num = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "context_still_queue_inspect_{}_{}_{}",
        name,
        std::process::id(),
        rand_num
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

pub(crate) fn create_claim_queue_table(connection: &Connection, table_name: &str) {
    connection
        .execute_batch(&format!(
            "
            create table {table_name} (
              id text primary key,
              status text not null,
              priority integer not null default 0,
              attempt_count integer not null default 0,
              created_at text not null,
              updated_at text not null,
              completed_at text,
              next_run_at text,
              locked_by text,
              locked_at text,
              heartbeat_at text,
              last_error text,
              last_outcome_kind text,
              provider_policy text,
              payload text,
              metadata text
            );
            "
        ))
        .unwrap();
}

pub(crate) fn create_provider_claim_queue_table(connection: &Connection, table_name: &str) {
    connection
        .execute_batch(&format!(
            "
            create table {table_name} (
              id text primary key,
              status text not null,
              priority integer not null default 0,
              attempt_count integer not null default 0,
              created_at text not null,
              updated_at text not null,
              completed_at text,
              next_run_at text,
              locked_by text,
              locked_at text,
              heartbeat_at text,
              last_error text,
              last_outcome_kind text,
              source_kind text,
              provider_policy text
            );
            "
        ))
        .unwrap();
}

pub(crate) fn create_provider_lease_table(connection: &Connection) {
    connection
        .execute_batch(
            r#"
            create table llm_provider_leases (
              id text primary key,
              pool_id text not null,
              target_id text not null,
              queue_name text not null,
              queue_job_id text not null,
              worker_id text not null,
              status text not null default 'active',
              locked_at text not null default CURRENT_TIMESTAMP,
              heartbeat_at text not null default CURRENT_TIMESTAMP,
              expires_at text not null,
              released_at text,
              release_reason text,
              metadata text not null default '{}',
              created_at text not null default CURRENT_TIMESTAMP,
              updated_at text not null default CURRENT_TIMESTAMP
            );
            create unique index llm_provider_leases_active_target_unique_idx
              on llm_provider_leases(target_id)
              where status = 'active';
            "#,
        )
        .unwrap();
}

pub(crate) fn create_queue_events_table(connection: &Connection) {
    connection
        .execute_batch(
            r#"
            create table distillation_queue_events (
              id text primary key,
              queue_name text not null,
              queue_job_id text not null,
              event_type text not null,
              message text,
              metadata text not null default '{}',
              created_at text not null default CURRENT_TIMESTAMP
            );
            "#,
        )
        .unwrap();
}

pub(crate) fn provider_pool() -> ProviderPoolClaimConfig {
    ProviderPoolClaimConfig {
        pool_id: "local-llm-default".to_string(),
        targets: vec!["local-a".to_string(), "local-b".to_string()],
        max_concurrent: 2,
        stale_lease_seconds: 120,
        low_priority_aging_seconds: 1800,
    }
}

pub(crate) fn finding_candidate_spec() -> ProviderQueueClaimSpec {
    ProviderQueueClaimSpec {
        queue_name: "findingCandidate".to_string(),
        preferred_target_ids: Vec::new(),
        route_target_column: Some("source_kind"),
        route_target_preferences: vec![
            RowTargetPreference {
                value: "source".to_string(),
                preferred_target_ids: vec!["local-a".to_string()],
            },
            RowTargetPreference {
                value: "vibe_memory".to_string(),
                preferred_target_ids: vec!["local-b".to_string()],
            },
        ],
        allowed_route_values: None,
        candidate_polarity_filter: super::types::CandidatePolarityFilter::Any,
        allowed_job_ids: None,
    }
}
