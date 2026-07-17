use rusqlite::params_from_iter;
use rusqlite::types::{Value as SqlValue, ValueRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{global_writer_for_path, TransactionControl};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteWriterRequest {
    pub client_id: String,
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    pub method: String,
    #[serde(default)]
    pub row_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteWriterResponse {
    pub ok: bool,
    pub rows: Vec<Value>,
    pub changes: u64,
    pub last_insert_rowid: i64,
}

pub fn execute_request(
    sqlite_path: &std::path::Path,
    request: SqliteWriterRequest,
) -> Result<SqliteWriterResponse, String> {
    validate_request(&request)?;
    let control = transaction_control(&request.sql);
    let operation = format!("remote_sql.{}", request.method);
    let client_id = request.client_id;
    let sql = request.sql;
    let method = request.method;
    let row_mode = request.row_mode.unwrap_or_else(|| "array".to_string());
    let params = request
        .params
        .into_iter()
        .map(json_to_sql_value)
        .collect::<Result<Vec<_>, _>>()?;
    global_writer_for_path(sqlite_path)?.execute_for_client(
        client_id,
        control,
        operation,
        move |connection| execute_sql(connection, &sql, &params, &method, &row_mode),
    )
}

fn validate_request(request: &SqliteWriterRequest) -> Result<(), String> {
    if request.client_id.trim().is_empty() || request.client_id.len() > 256 {
        return Err("writer clientId must contain 1-256 characters".to_string());
    }
    if request.sql.trim().is_empty() || request.sql.len() > 16 * 1024 * 1024 {
        return Err("writer SQL must contain 1-16777216 characters".to_string());
    }
    if !matches!(
        request.method.as_str(),
        "run" | "all" | "get" | "values" | "exec"
    ) {
        return Err("writer method must be run, all, get, values, or exec".to_string());
    }
    if request.params.len() > 65_535 {
        return Err("writer request contains too many parameters".to_string());
    }
    let statements = sql_statement_tokens(&request.sql);
    for tokens in &statements {
        let command = command_tokens(tokens);
        if matches!(
            command.first().map(String::as_str),
            Some("attach" | "detach")
        ) {
            return Err("writer protocol forbids ATTACH and DETACH".to_string());
        }
        if command.first().is_some_and(|token| token == "pragma")
            && command
                .iter()
                .skip(1)
                .any(|token| matches!(token.as_str(), "writable_schema" | "temp_store_directory"))
        {
            return Err("writer protocol forbids unsafe writable PRAGMAs".to_string());
        }
        if matches!(
            command.first().map(String::as_str),
            Some("savepoint" | "release")
        ) || (command.first().is_some_and(|token| token == "rollback")
            && command.get(1).is_some_and(|token| token == "to"))
        {
            return Err(
                "writer protocol does not support standalone SQLite savepoints".to_string(),
            );
        }
    }
    let transaction_scan_start = trigger_end_statement(&statements).map_or(0, |index| index + 1);
    let transaction_statements = statements
        .iter()
        .skip(transaction_scan_start)
        .filter(|tokens| is_transaction_statement(tokens))
        .count();
    if transaction_statements > 0 && statements.len() != 1 {
        return Err(
            "writer protocol requires transaction control to be sent as a standalone statement"
                .to_string(),
        );
    }
    Ok(())
}

fn transaction_control(sql: &str) -> TransactionControl {
    let statements = sql_statement_tokens(sql);
    let tokens = statements.first().map(Vec::as_slice).unwrap_or_default();
    if tokens.first().is_some_and(|token| token == "begin") {
        TransactionControl::Begin
    } else if tokens
        .first()
        .is_some_and(|token| matches!(token.as_str(), "commit" | "end"))
        || (tokens.first().is_some_and(|token| token == "rollback")
            && tokens.get(1).is_none_or(|token| token != "to"))
    {
        TransactionControl::End
    } else {
        TransactionControl::None
    }
}

fn is_transaction_statement(tokens: &[String]) -> bool {
    tokens
        .first()
        .is_some_and(|token| matches!(token.as_str(), "begin" | "commit" | "rollback" | "end"))
}

fn trigger_end_statement(statements: &[Vec<String>]) -> Option<usize> {
    let first = statements.first()?;
    let trigger_keyword = if first.first().is_some_and(|token| token == "create")
        && first
            .get(1)
            .is_some_and(|token| matches!(token.as_str(), "temp" | "temporary"))
    {
        first.get(2)
    } else {
        first.get(1)
    };
    if trigger_keyword.is_none_or(|token| token != "trigger") {
        return None;
    }
    statements.iter().position(|tokens| {
        command_tokens(tokens)
            .first()
            .is_some_and(|token| token == "end")
    })
}

fn command_tokens(tokens: &[String]) -> &[String] {
    if tokens.first().is_some_and(|token| token == "explain") {
        if tokens.get(1).is_some_and(|token| token == "query")
            && tokens.get(2).is_some_and(|token| token == "plan")
        {
            return tokens.get(3..).unwrap_or_default();
        }
        return tokens.get(1..).unwrap_or_default();
    }
    tokens
}

/// Tokenizes statement boundaries while ignoring comments and string literals. This keeps
/// protocol validation from being bypassed with `SELECT 1; ATTACH ...` without rejecting words
/// such as `ATTACH` that only occur inside user data.
fn sql_statement_tokens(sql: &str) -> Vec<Vec<String>> {
    #[derive(Clone, Copy)]
    enum State {
        Normal,
        SingleQuoted,
        DoubleQuoted,
        BacktickQuoted,
        BracketQuoted,
        LineComment,
        BlockComment,
    }

    fn finish_token(token: &mut String, statement: &mut Vec<String>) {
        if !token.is_empty() {
            statement.push(std::mem::take(token));
        }
    }

    fn finish_statement(
        token: &mut String,
        statement: &mut Vec<String>,
        statements: &mut Vec<Vec<String>>,
    ) {
        finish_token(token, statement);
        if !statement.is_empty() {
            statements.push(std::mem::take(statement));
        }
    }

    let mut state = State::Normal;
    let mut chars = sql.chars().peekable();
    let mut token = String::new();
    let mut statement = Vec::new();
    let mut statements = Vec::new();
    while let Some(character) = chars.next() {
        match state {
            State::Normal => match character {
                '\'' => {
                    finish_token(&mut token, &mut statement);
                    state = State::SingleQuoted;
                }
                '"' => {
                    finish_token(&mut token, &mut statement);
                    state = State::DoubleQuoted;
                }
                '`' => {
                    finish_token(&mut token, &mut statement);
                    state = State::BacktickQuoted;
                }
                '[' => {
                    finish_token(&mut token, &mut statement);
                    state = State::BracketQuoted;
                }
                '-' if chars.peek() == Some(&'-') => {
                    chars.next();
                    finish_token(&mut token, &mut statement);
                    state = State::LineComment;
                }
                '/' if chars.peek() == Some(&'*') => {
                    chars.next();
                    finish_token(&mut token, &mut statement);
                    state = State::BlockComment;
                }
                ';' => finish_statement(&mut token, &mut statement, &mut statements),
                character if character.is_ascii_alphanumeric() || character == '_' => {
                    token.push(character.to_ascii_lowercase());
                }
                _ => finish_token(&mut token, &mut statement),
            },
            State::SingleQuoted => {
                if character == '\'' {
                    if chars.peek() == Some(&'\'') {
                        chars.next();
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::DoubleQuoted => {
                if character == '"' {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        token.push('"');
                    } else {
                        finish_token(&mut token, &mut statement);
                        state = State::Normal;
                    }
                } else {
                    token.push(character.to_ascii_lowercase());
                }
            }
            State::BacktickQuoted => {
                if character == '`' {
                    if chars.peek() == Some(&'`') {
                        chars.next();
                        token.push('`');
                    } else {
                        finish_token(&mut token, &mut statement);
                        state = State::Normal;
                    }
                } else {
                    token.push(character.to_ascii_lowercase());
                }
            }
            State::BracketQuoted => {
                if character == ']' {
                    finish_token(&mut token, &mut statement);
                    state = State::Normal;
                } else {
                    token.push(character.to_ascii_lowercase());
                }
            }
            State::LineComment => {
                if character == '\n' {
                    state = State::Normal;
                }
            }
            State::BlockComment => {
                if character == '*' && chars.peek() == Some(&'/') {
                    chars.next();
                    state = State::Normal;
                }
            }
        }
    }
    finish_statement(&mut token, &mut statement, &mut statements);
    statements
}

fn execute_sql(
    connection: &mut rusqlite::Connection,
    sql: &str,
    params: &[SqlValue],
    method: &str,
    row_mode: &str,
) -> Result<SqliteWriterResponse, String> {
    if method == "exec" {
        if !params.is_empty() {
            return Err("writer exec method does not accept parameters".to_string());
        }
        connection
            .execute_batch(sql)
            .map_err(|error| format!("SQLite writer exec failed: {error}"))?;
        return Ok(SqliteWriterResponse {
            ok: true,
            rows: Vec::new(),
            changes: connection.changes(),
            last_insert_rowid: connection.last_insert_rowid(),
        });
    }

    if matches!(
        transaction_control(sql),
        TransactionControl::Begin | TransactionControl::End
    ) {
        if !params.is_empty() {
            return Err("transaction control does not accept parameters".to_string());
        }
        connection
            .execute_batch(sql)
            .map_err(|error| format!("SQLite writer transaction control failed: {error}"))?;
        return Ok(SqliteWriterResponse {
            ok: true,
            rows: Vec::new(),
            changes: connection.changes(),
            last_insert_rowid: connection.last_insert_rowid(),
        });
    }

    if method == "run" {
        let mut statement = connection
            .prepare(sql)
            .map_err(|error| format!("SQLite writer prepare failed: {error}"))?;
        let changes = if statement.column_count() == 0 {
            statement
                .execute(params_from_iter(params.iter()))
                .map_err(|error| format!("SQLite writer run failed: {error}"))? as u64
        } else {
            let mut rows = statement
                .query(params_from_iter(params.iter()))
                .map_err(|error| format!("SQLite writer run query failed: {error}"))?;
            while rows
                .next()
                .map_err(|error| format!("SQLite writer run row failed: {error}"))?
                .is_some()
            {}
            connection.changes()
        };
        return Ok(SqliteWriterResponse {
            ok: true,
            rows: Vec::new(),
            changes,
            last_insert_rowid: connection.last_insert_rowid(),
        });
    }

    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("SQLite writer prepare failed: {error}"))?;
    let column_names = statement
        .column_names()
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let mut query = statement
        .query(params_from_iter(params.iter()))
        .map_err(|error| format!("SQLite writer query failed: {error}"))?;
    let mut rows = Vec::new();
    while let Some(row) = query
        .next()
        .map_err(|error| format!("SQLite writer row read failed: {error}"))?
    {
        let values = (0..column_names.len())
            .map(|index| {
                row.get_ref(index)
                    .map(sql_ref_to_json)
                    .map_err(|error| format!("SQLite writer column read failed: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        if row_mode == "object" {
            rows.push(Value::Object(
                column_names.iter().cloned().zip(values).collect(),
            ));
        } else {
            rows.push(Value::Array(values));
        }
        if method == "get" {
            break;
        }
    }
    Ok(SqliteWriterResponse {
        ok: true,
        rows,
        changes: connection.changes(),
        last_insert_rowid: connection.last_insert_rowid(),
    })
}

fn json_to_sql_value(value: Value) -> Result<SqlValue, String> {
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::Bool(value) => Ok(SqlValue::Integer(i64::from(value))),
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                Ok(SqlValue::Integer(value))
            } else if let Some(value) = value.as_f64() {
                Ok(SqlValue::Real(value))
            } else {
                Err("SQLite writer cannot represent numeric parameter".to_string())
            }
        }
        Value::String(value) => Ok(SqlValue::Text(value)),
        Value::Array(value) => serde_json::to_string(&value)
            .map(SqlValue::Text)
            .map_err(|error| format!("failed to serialize array parameter: {error}")),
        Value::Object(value) => {
            if value.len() == 1 {
                if let Some(Value::Array(bytes)) = value.get("$contextStillBlob") {
                    let bytes = bytes
                        .iter()
                        .map(|value| {
                            value
                                .as_u64()
                                .filter(|value| *value <= u8::MAX as u64)
                                .map(|value| value as u8)
                                .ok_or_else(|| {
                                    "SQLite writer blob contains a non-byte value".to_string()
                                })
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    return Ok(SqlValue::Blob(bytes));
                }
            }
            serde_json::to_string(&value)
                .map(SqlValue::Text)
                .map_err(|error| format!("failed to serialize object parameter: {error}"))
        }
    }
}

fn sql_ref_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(value) => Value::from(value),
        ValueRef::Real(value) => Value::from(value),
        ValueRef::Text(value) => Value::String(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) => Value::Array(value.iter().copied().map(Value::from).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domains::sqlite_writer::{install_global_writer, SqliteWriterRuntime};

    fn request(sql: &str, method: &str) -> SqliteWriterRequest {
        SqliteWriterRequest {
            client_id: "validation-test".to_string(),
            sql: sql.to_string(),
            params: vec![],
            method: method.to_string(),
            row_mode: None,
        }
    }

    #[test]
    fn validation_checks_every_statement_for_forbidden_commands() {
        let error = validate_request(&request(
            "SELECT 'ATTACH DATABASE harmless'; /* boundary */ ATTACH DATABASE ':memory:' AS extra",
            "exec",
        ))
        .unwrap_err();
        assert!(error.contains("ATTACH"));

        let error = validate_request(&request(
            "SELECT 1; PRAGMA main.\"writable_schema\" = ON",
            "exec",
        ))
        .unwrap_err();
        assert!(error.contains("PRAGMA"));

        validate_request(&request(
            "SELECT 'ATTACH DATABASE :memory: AS harmless'",
            "get",
        ))
        .unwrap();
    }

    #[test]
    fn validation_requires_transaction_control_to_be_standalone() {
        let error = validate_request(&request(
            "BEGIN IMMEDIATE; INSERT INTO settings(id) VALUES ('hidden')",
            "exec",
        ))
        .unwrap_err();
        assert!(error.contains("standalone statement"));

        let error = validate_request(&request("SELECT 1; COMMIT", "exec")).unwrap_err();
        assert!(error.contains("standalone statement"));
        validate_request(&request("/* comment */ BEGIN IMMEDIATE;", "run")).unwrap();
    }

    #[test]
    fn validation_allows_semicolons_inside_trigger_body() {
        validate_request(&request(
            "CREATE TRIGGER update_timestamp AFTER UPDATE ON settings BEGIN UPDATE settings SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END;",
            "exec",
        ))
        .unwrap();
    }

    #[test]
    fn tagged_blob_parameter_is_preserved_as_sqlite_blob() {
        let value = json_to_sql_value(serde_json::json!({
            "$contextStillBlob": [0, 1, 127, 255]
        }))
        .unwrap();
        assert_eq!(value, SqlValue::Blob(vec![0, 1, 127, 255]));
        assert!(json_to_sql_value(serde_json::json!({
            "$contextStillBlob": [256]
        }))
        .unwrap_err()
        .contains("non-byte"));
    }

    #[test]
    fn protocol_executes_remote_transaction_on_writer() {
        let path = std::env::temp_dir().join(format!(
            "context_still_protocol_{}_{}.sqlite",
            std::process::id(),
            crate::domains::process_lifecycle::service::now_timestamp().replace([':', '.'], "-")
        ));
        let runtime = SqliteWriterRuntime::start(&path, 16, 8).unwrap();
        install_global_writer(runtime.handle()).unwrap();
        let client_id = "protocol-test".to_string();
        execute_request(
            &path,
            SqliteWriterRequest {
                client_id: client_id.clone(),
                sql: "BEGIN IMMEDIATE".to_string(),
                params: vec![],
                method: "run".to_string(),
                row_mode: None,
            },
        )
        .unwrap();
        execute_request(
            &path,
            SqliteWriterRequest {
                client_id: client_id.clone(),
                sql: "INSERT INTO settings(id, namespace, key, value) VALUES (?, ?, ?, ?)"
                    .to_string(),
                params: vec![
                    Value::from("protocol-setting"),
                    Value::from("test"),
                    Value::from("protocol"),
                    Value::from("{}"),
                ],
                method: "run".to_string(),
                row_mode: None,
            },
        )
        .unwrap();
        execute_request(
            &path,
            SqliteWriterRequest {
                client_id,
                sql: "COMMIT".to_string(),
                params: vec![],
                method: "run".to_string(),
                row_mode: None,
            },
        )
        .unwrap();
        let response = execute_request(
            &path,
            SqliteWriterRequest {
                client_id: "reader".to_string(),
                sql: "SELECT id FROM settings WHERE id = ?".to_string(),
                params: vec![Value::from("protocol-setting")],
                method: "get".to_string(),
                row_mode: Some("object".to_string()),
            },
        )
        .unwrap();
        assert_eq!(response.rows[0]["id"], "protocol-setting");
        crate::domains::sqlite_writer::clear_global_writer(&path);
        runtime.shutdown().unwrap();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}.writer.lock", path.display()));
    }
}
