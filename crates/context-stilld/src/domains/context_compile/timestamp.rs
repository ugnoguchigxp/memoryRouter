pub const MAX_EPOCH_MS: i64 = 8_640_000_000_000_000;

pub fn format_unix_ms(epoch_ms: i64) -> Option<String> {
    (0..=MAX_EPOCH_MS)
        .contains(&epoch_ms)
        .then(|| format!("unix-ms:{epoch_ms}"))
}

pub fn parse_unix_ms(value: &str) -> Option<i64> {
    let digits = value.strip_prefix("unix-ms:")?;
    if digits.is_empty() || digits.len() > 16 || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    digits
        .parse::<i64>()
        .ok()
        .filter(|value| (0..=MAX_EPOCH_MS).contains(value))
}

/// Returns a SQLite expression that converts a trusted timestamp column to Unix milliseconds.
///
/// The expression accepts only the Foundation canonical `unix-ms:` representation and SQLite's
/// ISO-8601 / `CURRENT_TIMESTAMP` date shape.  Everything else becomes `NULL`, so report code
/// can exclude malformed rows without guessing their meaning.
pub fn sqlite_timestamp_millis_expression(column: &str) -> String {
    format!(
        r#"
        case
          when {column} glob 'unix-ms:*'
            and length(substr({column}, 9)) between 1 and 16
            and substr({column}, 9) not glob '*[^0-9]*'
            and cast(substr({column}, 9) as integer) between 0 and {MAX_EPOCH_MS}
            then cast(substr({column}, 9) as integer)
          when length({column}) >= 19
            and substr({column}, 5, 1) = '-'
            and substr({column}, 8, 1) = '-'
            and (substr({column}, 11, 1) = 'T' or substr({column}, 11, 1) = ' ')
            and substr({column}, 14, 1) = ':'
            and substr({column}, 17, 1) = ':'
            and julianday({column}) is not null
            and round((julianday({column}) - 2440587.5) * 86400000) between 0 and {MAX_EPOCH_MS}
            then cast(round((julianday({column}) - 2440587.5) * 86400000) as integer)
          else null
        end
        "#
    )
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::{format_unix_ms, parse_unix_ms, sqlite_timestamp_millis_expression, MAX_EPOCH_MS};

    #[test]
    fn accepts_only_bounded_unsigned_canonical_values() {
        assert_eq!(parse_unix_ms("unix-ms:0"), Some(0));
        assert_eq!(parse_unix_ms("unix-ms:42"), Some(42));
        assert_eq!(parse_unix_ms("unix-ms:1junk"), None);
        assert_eq!(parse_unix_ms("unix-ms:-1"), None);
        assert_eq!(parse_unix_ms("unix-ms:"), None);
        assert_eq!(parse_unix_ms("unix-ms:8640000000000001"), None);
        assert_eq!(
            format_unix_ms(MAX_EPOCH_MS),
            Some("unix-ms:8640000000000000".to_string())
        );
    }

    #[test]
    fn sqlite_projection_accepts_canonical_and_sqlite_timestamps_only() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "create table timestamps (value text);\
                 insert into timestamps (value) values \
                 ('unix-ms:1700000000000'), \
                 ('2026-08-17 00:00:00'), \
                 ('2026-08-17T00:00:00Z'), \
                 ('unix-ms:1junk'), \
                 ('2026-08-17'), \
                 ('not-a-timestamp');",
            )
            .unwrap();
        let expression = sqlite_timestamp_millis_expression("value");
        let sql = format!("select {expression} from timestamps order by rowid");
        let values = connection
            .prepare(&sql)
            .unwrap()
            .query_map([], |row| row.get::<_, Option<i64>>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(values[0], Some(1_700_000_000_000));
        assert_eq!(values[1], values[2]);
        assert!(values[1].is_some());
        assert_eq!(values[3..], [None, None, None]);
    }
}
