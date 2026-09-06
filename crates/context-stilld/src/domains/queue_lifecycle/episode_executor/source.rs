use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};

use crate::shared::errors::CliError;

use super::helpers::{
    nearest_char_boundary, parse_json_or_empty, parse_unixish, push_optional_line,
    slice_bytes_lossy, table_exists, to_isoish,
};
use super::types::{EpisodeDistillerJobRow, Segment, SourceDocument, SourceEvent};

pub(super) fn load_job(
    connection: &Connection,
    job_id: &str,
) -> Result<EpisodeDistillerJobRow, CliError> {
    connection
        .query_row(
            "
            select id, source_kind, source_key, attempt_count, max_attempts, coalesce(metadata, '{}')
            from episode_distiller_queue
            where id = ?1
            limit 1
            ",
            [job_id],
            |row| {
                Ok(EpisodeDistillerJobRow {
                    id: row.get(0)?,
                    source_kind: row.get(1)?,
                    source_key: row.get(2)?,
                    attempt_count: row.get(3)?,
                    max_attempts: row.get(4)?,
                    metadata: parse_json_or_empty(&row.get::<_, String>(5)?),
                })
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load episode distiller job: {error}")))?
        .ok_or_else(|| CliError::io(format!("episode distiller queue job not found: {job_id}")))
}

pub(super) fn read_source_document(
    connection: &Connection,
    vibe_memory_id: &str,
) -> Result<SourceDocument, CliError> {
    let memory = connection
        .query_row(
            "
            select id, session_id, content, coalesce(metadata, '{}'), created_at
            from vibe_memories
            where id = ?1
            limit 1
            ",
            [vibe_memory_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| CliError::io(format!("failed to load vibe memory: {error}")))?
        .ok_or_else(|| CliError::io(format!("vibe memory not found: {vibe_memory_id}")))?;

    let mut parts = Vec::new();
    let mut events = Vec::new();
    append_source_block(
        &mut parts,
        &mut events,
        format!("memory:{}", memory.0),
        memory.4.clone(),
        None,
        format!(
            "[event:memory:{}]\ncreated_at: {}\nsession_id: {}\n\n{}\n",
            memory.0,
            to_isoish(&memory.4),
            memory.1,
            memory.2.trim()
        ),
    );

    if table_exists(connection, "agent_diff_entries")? {
        let mut statement = connection
            .prepare(
                "
                select id, file_path, diff_hunk, change_type, language, symbol_name,
                       symbol_kind, signature, start_line, end_line, created_at
                from agent_diff_entries
                where vibe_memory_id = ?1
                order by created_at asc, file_path asc, id asc
                ",
            )
            .map_err(|error| CliError::io(format!("failed to prepare source diffs: {error}")))?;
        let rows = statement
            .query_map([vibe_memory_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, String>(10)?,
                ))
            })
            .map_err(|error| CliError::io(format!("failed to query source diffs: {error}")))?;
        for row in rows {
            let (
                id,
                file_path,
                diff_hunk,
                change_type,
                language,
                symbol_name,
                symbol_kind,
                signature,
                start_line,
                end_line,
                created_at,
            ) =
                row.map_err(|error| CliError::io(format!("failed to read source diff: {error}")))?;
            let mut lines = vec![
                format!("[event:agent_diff:{id}]"),
                format!("created_at: {}", to_isoish(&created_at)),
                format!("file_path: {file_path}"),
            ];
            push_optional_line(&mut lines, "change_type", change_type.as_deref());
            push_optional_line(&mut lines, "language", language.as_deref());
            push_optional_line(&mut lines, "symbol_name", symbol_name.as_deref());
            push_optional_line(&mut lines, "symbol_kind", symbol_kind.as_deref());
            push_optional_line(&mut lines, "signature", signature.as_deref());
            if start_line.is_some() || end_line.is_some() {
                lines.push(format!(
                    "line_range: {}-{}",
                    start_line
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "?".to_string()),
                    end_line
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "?".to_string())
                ));
            }
            lines.push(String::new());
            lines.push(diff_hunk.trim().to_string());
            lines.push(String::new());
            append_source_block(
                &mut parts,
                &mut events,
                format!("agent_diff:{id}"),
                created_at,
                Some(file_path),
                lines.join("\n"),
            );
        }
    }

    Ok(SourceDocument {
        vibe_memory_id: memory.0,
        session_id: memory.1,
        content: parts.join(""),
        metadata: parse_json_or_empty(&memory.3),
        events,
    })
}

pub(super) fn append_source_block(
    parts: &mut Vec<String>,
    events: &mut Vec<SourceEvent>,
    id: String,
    created_at: String,
    file_path: Option<String>,
    body: String,
) {
    let start_offset = parts.iter().map(|part| part.len()).sum();
    parts.push(body);
    let end_offset = parts.iter().map(|part| part.len()).sum();
    events.push(SourceEvent {
        id,
        created_at,
        file_path,
        start_offset,
        end_offset,
    });
}

pub(super) fn build_deterministic_segments(document: &SourceDocument) -> Vec<Segment> {
    let max_bytes = 4000 * 4;
    if document.events.is_empty() {
        return vec![Segment {
            text: document.content.clone(),
            start_offset: 0,
            end_offset: document.content.len(),
            event_start: None,
            event_end: None,
            event_ids: Vec::new(),
        }];
    }
    let mut segments = Vec::new();
    let mut current: Vec<SourceEvent> = vec![document.events[0].clone()];
    for event in document.events.iter().skip(1) {
        let first = current.first().expect("current segment has first event");
        let previous = current.last().expect("current segment has last event");
        let file_boundary = !current
            .iter()
            .filter_map(|item| item.file_path.as_deref())
            .collect::<HashSet<_>>()
            .is_empty()
            && event.file_path.as_deref().is_some_and(|path| {
                !current
                    .iter()
                    .any(|item| item.file_path.as_deref() == Some(path))
            });
        let projected_bytes = event.end_offset.saturating_sub(first.start_offset);
        let time_boundary = parse_unixish(&event.created_at)
            .zip(parse_unixish(&previous.created_at))
            .map(|(current_at, previous_at)| current_at.saturating_sub(previous_at) >= 30 * 60)
            .unwrap_or(false);
        if time_boundary || file_boundary || projected_bytes > max_bytes {
            push_segment(document, &mut segments, &current);
            current = vec![event.clone()];
        } else {
            current.push(event.clone());
        }
    }
    push_segment(document, &mut segments, &current);
    segments
        .into_iter()
        .flat_map(|segment| split_large_segment(segment, max_bytes))
        .collect()
}

pub(super) fn push_segment(
    document: &SourceDocument,
    segments: &mut Vec<Segment>,
    events: &[SourceEvent],
) {
    let Some(first) = events.first() else {
        return;
    };
    let Some(last) = events.last() else {
        return;
    };
    segments.push(Segment {
        text: slice_bytes_lossy(&document.content, first.start_offset, last.end_offset),
        start_offset: first.start_offset,
        end_offset: last.end_offset,
        event_start: Some(first.id.clone()),
        event_end: Some(last.id.clone()),
        event_ids: events.iter().map(|item| item.id.clone()).collect(),
    });
}

pub(super) fn split_large_segment(segment: Segment, max_bytes: usize) -> Vec<Segment> {
    if segment.end_offset.saturating_sub(segment.start_offset) <= max_bytes {
        return vec![segment];
    }
    let mut chunks = Vec::new();
    let mut start = segment.start_offset;
    while start < segment.end_offset {
        let end = nearest_char_boundary(
            &segment.text,
            (start - segment.start_offset + max_bytes).min(segment.text.len()),
        ) + segment.start_offset;
        let end = end.max(start + 1).min(segment.end_offset);
        chunks.push(Segment {
            text: slice_bytes_lossy(
                &segment.text,
                start - segment.start_offset,
                end - segment.start_offset,
            ),
            start_offset: start,
            end_offset: end,
            event_start: segment.event_start.clone(),
            event_end: segment.event_end.clone(),
            event_ids: segment.event_ids.clone(),
        });
        start = end;
    }
    chunks
}
