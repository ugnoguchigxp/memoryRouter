use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(super) const QUEUE: &str = "landscapeCuration";
pub(super) const VERSION: &str = "landscape-curation-rust-v2";

pub(super) fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

// A review is bound to the semantic content revision. Usage timestamps do not enter the
// revision, while body, applicability, identity, metadata, and provenance-affecting fields do.
// This lets new or changed Landscape knowledge re-enter Curation without looping on queue state.
pub(super) fn enqueue_all(connection: &Connection) -> Result<usize, String> {
    let exists: bool = connection
        .query_row(
            "select exists(select 1 from sqlite_master where name = 'landscape_curation_queue')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Ok(0);
    }
    let mut statement = connection
        .prepare("select id from knowledge_items where status='active' order by id")
        .map_err(|e| e.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut inserted = 0;
    for knowledge_id in ids {
        let knowledge =
            load_knowledge(connection, &knowledge_id)?.ok_or("active knowledge disappeared")?;
        let revision = content_revision(&knowledge);
        let key = format!("landscape-v2:{knowledge_id}:{revision}");
        let already_reviewed: bool = connection
            .query_row(
                "select exists(select 1 from landscape_curation_queue where subject_knowledge_id=?1 and evidence_hash=?2)",
                params![knowledge_id, revision],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if already_reviewed {
            continue;
        }
        inserted += connection.execute(
            "insert or ignore into landscape_curation_queue
             (id,finding_type,subject_knowledge_id,fingerprint,idempotency_key,evidence_hash,
              repository_identity,detector_version,prompt_version)
             values (?1,'duplicate_candidate',?2,?3,?3,?4,?5,?6,?6)",
            params![
                key,
                knowledge_id,
                format!("curation:{revision}"),
                revision,
                json!({"key":knowledge["repoKey"],"path":knowledge["repoPath"],"projectRef":knowledge["projectRef"]}).to_string(),
                VERSION,
            ],
        ).map_err(|e| format!("failed to enqueue Landscape knowledge: {e}"))?;
    }
    Ok(inserted)
}

pub(super) fn load_knowledge(connection: &Connection, id: &str) -> Result<Option<Value>, String> {
    connection.query_row(
        "select json_object('id',id,'title',title,'body',body,'type',type,'polarity',polarity,
         'scope',scope,'status',status,'classificationStatus',classification_status,
         'repoKey',repo_key,'repoPath',repo_path,'projectRef',project_ref,
         'appliesTo',json(applies_to),'metadata',json(metadata),'confidence',confidence,
         'importance',importance,'createdAt',strftime('%Y-%m-%dT%H:%M:%fZ',created_at),'updatedAt',strftime('%Y-%m-%dT%H:%M:%fZ',updated_at),
         'lastVerifiedAt',strftime('%Y-%m-%dT%H:%M:%fZ',last_verified_at))
         from knowledge_items where id = ?1", [id], |row| row.get::<_,String>(0),
    ).optional().map_err(|e| e.to_string())?
        .map(|s| {
            let mut row: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
            row["bodyHash"] = json!(hash(row["body"].as_str().unwrap_or_default()));
            row["appliesToHash"] = json!(hash(&canonical_json(&row["appliesTo"])));
            row["contentRevision"] = json!(content_revision(&row));
            row["sourceGroups"] = json!([{
                "id": format!("{}:g0", row["id"].as_str().unwrap_or_default()),
                "text": row["body"].as_str().unwrap_or_default(),
                "hash": hash(row["body"].as_str().unwrap_or_default()),
                "order": 0
            }]);
            Ok(row)
        }).transpose()
}

pub(super) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        _ => value.to_string(),
    }
}

pub(super) fn content_revision(item: &Value) -> String {
    hash(&canonical_json(&json!({
        "title": item["title"], "body": item["body"], "type": item["type"],
        "polarity": item["polarity"], "scope": item["scope"], "repoKey": item["repoKey"],
        "repoPath": item["repoPath"], "projectRef": item["projectRef"],
        "appliesTo": item["appliesTo"], "metadata": item["metadata"]
    })))
}

pub(super) fn same_applicability(left: &Value, right: &Value) -> bool {
    canonical_json(left) == canonical_json(right)
}

pub(super) fn same_repository(a: &Value, b: &Value) -> bool {
    if a["scope"] != b["scope"] {
        return false;
    }
    if a["scope"] == "global" {
        return true;
    }
    let mut shared = false;
    for key in ["repoKey", "repoPath", "projectRef"] {
        let left = a[key].as_str().map(str::trim).filter(|s| !s.is_empty());
        let right = b[key].as_str().map(str::trim).filter(|s| !s.is_empty());
        if let (Some(left), Some(right)) = (left, right) {
            if left != right {
                return false;
            }
            shared = true;
        }
    }
    shared
}

pub(super) fn unchanged(a: &Value, b: &Value) -> bool {
    [
        "id",
        "title",
        "body",
        "type",
        "polarity",
        "scope",
        "status",
        "repoKey",
        "repoPath",
        "projectRef",
        "appliesTo",
    ]
    .iter()
    .all(|key| a[key] == b[key])
}

fn cosine(a: &[f64], b: &[f64]) -> Option<f64> {
    if a.len() != b.len() || a.is_empty() {
        return None;
    }
    let dot: f64 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let norm =
        a.iter().map(|x| x * x).sum::<f64>().sqrt() * b.iter().map(|x| x * x).sum::<f64>().sqrt();
    (norm > 0.0 && dot.is_finite()).then(|| (dot / norm).clamp(0.0, 1.0))
}

fn lexical_similarity(left: &str, right: &str) -> f64 {
    fn grams(value: &str) -> HashSet<String> {
        let chars = value
            .to_lowercase()
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<Vec<_>>();
        if chars.len() < 2 {
            return chars
                .into_iter()
                .map(|character| character.to_string())
                .collect();
        }
        chars
            .windows(2)
            .map(|pair| pair.iter().collect::<String>())
            .collect()
    }
    let left = grams(left);
    let right = grams(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let intersection = left.intersection(&right).count() as f64;
    intersection / left.union(&right).count() as f64
}

pub(super) fn capture(connection: &Connection, job_id: &str) -> Result<Value, String> {
    let subject_id: String = connection
        .query_row(
            "select subject_knowledge_id from landscape_curation_queue where id = ?1",
            [job_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let subject = load_knowledge(connection, &subject_id)?.ok_or("subject knowledge missing")?;
    let vector: Option<Vec<f64>> = connection
        .query_row(
            "select embedding_json from knowledge_items_vec_fallback where knowledge_id = ?1",
            [&subject_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .and_then(|s| serde_json::from_str(&s).ok());
    let mut statement = connection.prepare(
        "select k.id, k.body, k.applies_to, k.repo_key, k.repo_path, k.project_ref, v.embedding_json
         from knowledge_items k left join knowledge_items_vec_fallback v on v.knowledge_id = k.id
         where k.id <> ?1 and k.status = 'active' and k.scope = ?2 and k.type = ?3 and k.polarity = ?4",
    ).map_err(|e|e.to_string())?;
    let rows = statement
        .query_map(
            params![
                subject_id,
                subject["scope"].as_str(),
                subject["type"].as_str(),
                subject["polarity"].as_str()
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .map_err(|e| e.to_string())?;
    let mut ranked = Vec::new();
    for row in rows {
        let (id, body, applies, key, path, project, embedding) = row.map_err(|e| e.to_string())?;
        let identity =
            json!({"scope":subject["scope"],"repoKey":key,"repoPath":path,"projectRef":project});
        if !same_repository(&subject, &identity) {
            continue;
        }
        let exact = subject["body"].as_str() == Some(body.as_str());
        let vector_similarity = if exact {
            Some(1.0)
        } else {
            vector.as_ref().and_then(|v| {
                embedding
                    .and_then(|s| serde_json::from_str::<Vec<f64>>(&s).ok())
                    .and_then(|other| cosine(v, &other))
            })
        };
        // Vector and lexical scores only select candidates. They never authorize a mutation. The
        // lexical fallback keeps knowledge without an embedding in the Curation path, including
        // Japanese text where whitespace tokenization is not sufficient.
        let lexical = if exact {
            1.0
        } else {
            lexical_similarity(subject["body"].as_str().unwrap_or_default(), &body)
        };
        let similarity = vector_similarity.unwrap_or(0.0).max(lexical);
        if exact || similarity >= 0.20 {
            let overlap = serde_json::from_str::<Value>(&applies)
                .ok()
                .is_some_and(|a| a == subject["appliesTo"]);
            ranked.push((id, similarity, overlap));
        }
    }
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    let mut candidates = Vec::new();
    for (id, similarity, overlap) in ranked.into_iter().take(5) {
        if let Some(mut candidate) = load_knowledge(connection, &id)? {
            candidate["similarity"] = json!(similarity);
            candidate["scopeOverlap"] = if overlap { json!(1) } else { Value::Null };
            candidates.push(candidate);
        }
    }
    let now = crate::domains::process_lifecycle::service::now_timestamp();
    let evidence = std::iter::once(&subject).chain(candidates.iter()).map(|k| json!({
        "id":format!("knowledge:{}",k["id"].as_str().unwrap_or_default()), "kind":"knowledge_content",
        "knowledgeId":k["id"],"value":{"body":k["body"],"appliesTo":k["appliesTo"]},
        "observedAt":now,"source":"knowledge_items"
    })).collect::<Vec<_>>();
    Ok(
        json!({"schemaVersion":1,"capturedAt":now,"subject":subject,"candidates":candidates,
        "evidence":evidence,"usage":{},"lineage":{},"reviewItem":null,
        "finding":{"type":"duplicate_candidate","reviewItemId":null,"evidenceHash":hash(&json!(evidence).to_string())},
        "capabilities":{"directDeprecation":true,"mode":"autonomous_policy"},
        "versions":{"detector":VERSION,"policy":"curation-policy-v1","prompt":VERSION}}),
    )
}
