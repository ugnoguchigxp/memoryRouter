use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use crate::domains::doctor;
use crate::shared::process::OsSupervisor;

use super::native_common::{
    collect_scores, content_json, int_arg, latest_run_id, now_iso, pseudo_uuid, string_arg,
    table_exists, tool_error, with_writer, HandlerEnv,
};
use super::native_compile;
use super::native_decision;
use super::native_episodes;
use super::native_knowledge;
use super::native_memory;
use super::native_tools::NativeToolContext;

pub(crate) fn doctor(context: &NativeToolContext) -> Value {
    let env = HandlerEnv::new(context);
    let report = doctor::service::summary(&env, &OsSupervisor);
    content_json(json!(report))
}

pub(crate) fn compile_eval(params: &Value, context: &NativeToolContext) -> Value {
    let owned_params = params.clone();
    match with_writer(context, "mcp.compile_eval", move |connection| {
        Ok(compile_eval_on_connection(&owned_params, connection))
    }) {
        Ok(value) => value,
        Err(error) => tool_error(&error),
    }
}

fn compile_eval_on_connection(params: &Value, connection: &mut rusqlite::Connection) -> Value {
    let Some(args) = params.get("arguments").and_then(Value::as_object) else {
        return tool_error("compile_eval arguments must be an object");
    };
    if !table_exists(connection, "context_compile_evals") {
        return tool_error("context_compile_evals table is not available");
    }

    let run_id = match string_arg(args, "runId").or_else(|| latest_run_id(params, connection)) {
        Some(run_id) => run_id,
        None => {
            return tool_error(
                "runId is required when no latest session context_compile run exists",
            )
        }
    };
    let run_session_row = connection
        .query_row(
            "select session_id from context_compile_runs where id = ?1 limit 1",
            [&run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .unwrap_or(None);
    let Some(run_session_id) = run_session_row else {
        return tool_error(&format!("context_compile run not found: {run_id}"));
    };

    let outcome = match string_arg(args, "outcome") {
        Some(value)
            if matches!(
                value.as_str(),
                "useful" | "partial" | "misleading" | "unused"
            ) =>
        {
            value
        }
        _ => return tool_error("outcome must be useful, partial, misleading, or unused"),
    };
    let body = match string_arg(args, "body") {
        Some(value) if !value.is_empty() => value,
        _ => return tool_error("body is required"),
    };
    let relevance = int_arg(args, "relevance");
    let actionability = int_arg(args, "actionability");
    let coverage = int_arg(args, "coverage");
    let clarity = int_arg(args, "clarity");
    let specificity = int_arg(args, "specificity");
    let Some(scores) = collect_scores([relevance, actionability, coverage, clarity, specificity])
    else {
        return tool_error(
            "relevance/actionability/coverage/clarity/specificity must be 0-100 integers",
        );
    };
    let avg = scores.iter().sum::<i64>() / scores.len() as i64;
    let id = pseudo_uuid();
    let now = now_iso();
    let title = string_arg(args, "title");
    let metadata = json!({"tool":"compile_eval","source":"rust-mcp-native"});
    let insert = connection.execute(
        r#"
        insert into context_compile_evals (
          id, run_id, session_id, score, outcome, title, body, source, metadata,
          relevance, actionability, coverage, clarity, specificity, created_at, updated_at
        ) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'mcp', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)
        "#,
        (
            &id,
            &run_id,
            run_session_id.as_deref(),
            avg,
            &outcome,
            title.as_deref(),
            &body,
            metadata.to_string(),
            scores[0],
            scores[1],
            scores[2],
            scores[3],
            scores[4],
            &now,
        ),
    );
    if let Err(error) = insert {
        return tool_error(&format!("failed to insert compile eval: {error}"));
    }

    content_json(json!({
        "evaluation": {
            "id": id,
            "runId": run_id,
            "sessionId": run_session_id,
            "avg": avg,
            "outcome": outcome,
            "title": title,
            "body": body,
            "source": "mcp",
            "relevance": scores[0],
            "actionability": scores[1],
            "coverage": scores[2],
            "clarity": scores[3],
            "specificity": scores[4],
            "createdAt": now,
            "updatedAt": now
        },
        "resolvedFrom": if string_arg(args, "runId").is_some() { "explicit_run_id" } else { "latest_session_run" }
    }))
}

pub(crate) fn context_compile(params: &Value, context: &NativeToolContext) -> Value {
    native_compile::context_compile(params, context)
}

pub(crate) fn context_decision(params: &Value, context: &NativeToolContext) -> Value {
    native_decision::context_decision(params, context)
}

pub(crate) fn search_memory(params: &Value, context: &NativeToolContext) -> Value {
    native_memory::search_memory(params, context)
}

pub(crate) fn fetch_memory(params: &Value, context: &NativeToolContext) -> Value {
    native_memory::fetch_memory(params, context)
}

pub(crate) fn search_episodes(params: &Value, context: &NativeToolContext) -> Value {
    native_episodes::search_episodes(params, context)
}

pub(crate) fn fetch_episode(params: &Value, context: &NativeToolContext) -> Value {
    native_episodes::fetch_episode(params, context)
}

pub(crate) fn search_knowledge(params: &Value, context: &NativeToolContext) -> Value {
    native_knowledge::search_knowledge(params, context)
}

pub(crate) fn context_decision_feedback(params: &Value, context: &NativeToolContext) -> Value {
    native_knowledge::context_decision_feedback(params, context)
}

pub(crate) fn register_candidates(params: &Value, context: &NativeToolContext) -> Value {
    native_knowledge::register_candidates(params, context)
}
