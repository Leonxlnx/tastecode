use super::{Result, Store, StoreError, now_ms, parse_provider, provider_key};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use harness_protocol::{
    DomainEvent, ItemType, ProviderId, SearchSnippetPart, SequencedDomainEvent, SessionSearchPage,
    SessionSearchResult, Usage,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{OptionalExtension as _, params, params_from_iter};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const SNIPPET_START: char = '\u{1}';
const SNIPPET_END: char = '\u{2}';
const SEARCH_INDEX_VERSION: &str = "session_search_v1";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SearchOptions {
    pub query: String,
    pub project_path: Option<String>,
    pub provider: Option<ProviderId>,
    pub cursor: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct UsageSummary {
    pub session: Usage,
    pub today: Usage,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchCursor {
    score: f64,
    created_at: i64,
    rowid: i64,
}

struct SearchRow {
    project_path: String,
    project_name: String,
    thread_id: String,
    thread_title: String,
    turn_id: String,
    provider: ProviderId,
    created_at: f64,
    search_rowid: i64,
    score: f64,
    snippet: String,
}

impl Store {
    pub fn append(&mut self, thread_id: &str, event: &DomainEvent) -> Result<u64> {
        self.append_with_provider_state(thread_id, event, None)
    }

    pub fn append_with_provider_state(
        &mut self,
        thread_id: &str,
        event: &DomainEvent,
        provider_state: Option<&Value>,
    ) -> Result<u64> {
        self.append_at_with_provider_state(thread_id, event, now_ms()?, provider_state)
    }

    pub fn append_at(&mut self, thread_id: &str, event: &DomainEvent, at: i64) -> Result<u64> {
        self.append_at_with_provider_state(thread_id, event, at, None)
    }

    fn append_at_with_provider_state(
        &mut self,
        thread_id: &str,
        event: &DomainEvent,
        at: i64,
        provider_state: Option<&Value>,
    ) -> Result<u64> {
        let payload = serde_json::to_string(event)?;
        let provider_state = provider_state.map(serde_json::to_string).transpose()?;
        let transaction = self.connection.transaction()?;
        {
            let mut insert_event = transaction.prepare_cached(
                "INSERT INTO events (thread_id, at, payload) VALUES (?1, ?2, ?3)",
            )?;
            insert_event.execute(params![thread_id, at, payload])?;
        }
        let seq = transaction.last_insert_rowid();
        index_event(&transaction, seq, thread_id, at, event)?;
        if let Some(provider_state) = provider_state {
            let mut update_provider_state = transaction.prepare_cached(
                "INSERT INTO provider_session_states (thread_id, state_json) VALUES (?1, ?2)
                 ON CONFLICT (thread_id) DO UPDATE SET state_json = excluded.state_json",
            )?;
            update_provider_state.execute(params![thread_id, provider_state])?;
        }
        transaction.commit()?;
        Ok(seq.max(0) as u64)
    }

    pub fn history(&self, thread_id: &str, after_seq: u64) -> Result<Vec<SequencedDomainEvent>> {
        let mut statement = self.connection.prepare(
            "SELECT seq, payload FROM events WHERE thread_id = ?1 AND seq > ?2 ORDER BY seq",
        )?;
        let rows = statement.query_map(params![thread_id, u64_to_i64(after_seq)], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (seq, payload) = row?;
            Ok(SequencedDomainEvent {
                seq: seq.max(0) as u64,
                event: serde_json::from_str(&payload)?,
            })
        })
        .collect()
    }

    pub fn last_seq(&self, thread_id: &str) -> Result<u64> {
        let seq = self.connection.query_row(
            "SELECT MAX(seq) FROM events WHERE thread_id = ?1",
            [thread_id],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        Ok(seq.unwrap_or(0).max(0) as u64)
    }

    pub fn search_sessions(&self, options: &SearchOptions) -> Result<SessionSearchPage> {
        let limit = options.limit.unwrap_or(25).clamp(1, 100);
        let cursor = decode_cursor(options.cursor.as_deref());
        let mut clauses = vec!["session_search MATCH ?".to_owned()];
        let mut search_parameters = vec![SqlValue::Text(to_fts_query(&options.query)?)];
        if let Some(project_path) = &options.project_path {
            clauses.push("threads.project_path = ?".into());
            search_parameters.push(SqlValue::Text(project_path.clone()));
        }
        if let Some(provider) = options.provider {
            clauses.push("threads.provider = ?".into());
            search_parameters.push(SqlValue::Text(provider_key(provider).into()));
        }
        let cursor_clause = if cursor.is_some() {
            "WHERE score > ?
             OR (score = ? AND created_at < ?)
             OR (score = ? AND created_at = ? AND search_rowid < ?)"
        } else {
            ""
        };
        let sql = format!(
            "WITH matches AS (
               SELECT projects.path AS project_path, projects.name AS project_name,
                      threads.id AS thread_id, threads.title AS thread_title,
                      threads.provider, session_search.turn_id, session_search.created_at,
                      session_search.rowid AS search_rowid, bm25(session_search) AS score,
                      snippet(session_search, 4, ?, ?, ' … ', 24) AS snippet
               FROM session_search
               JOIN threads ON threads.id = session_search.thread_id
               JOIN projects ON projects.path = threads.project_path
               WHERE {}
             )
             SELECT project_path, project_name, thread_id, thread_title, provider, turn_id,
                    created_at, search_rowid, score, snippet
             FROM matches
             {cursor_clause}
             ORDER BY score, created_at DESC, search_rowid DESC
             LIMIT ?",
            clauses.join(" AND ")
        );
        let mut parameters = vec![
            SqlValue::Text(SNIPPET_START.into()),
            SqlValue::Text(SNIPPET_END.into()),
        ];
        parameters.extend(search_parameters);
        if let Some(cursor) = cursor {
            parameters.extend([
                SqlValue::Real(cursor.score),
                SqlValue::Real(cursor.score),
                SqlValue::Integer(cursor.created_at),
                SqlValue::Real(cursor.score),
                SqlValue::Integer(cursor.created_at),
                SqlValue::Integer(cursor.rowid),
            ]);
        }
        parameters.push(SqlValue::Integer((limit + 1) as i64));

        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement
            .query_map(params_from_iter(parameters.iter()), |row| {
                let provider: String = row.get(4)?;
                let provider = parse_provider(&provider).map_err(store_conversion_error)?;
                Ok(SearchRow {
                    project_path: row.get(0)?,
                    project_name: row.get(1)?,
                    thread_id: row.get(2)?,
                    thread_title: row.get(3)?,
                    provider,
                    turn_id: row.get(5)?,
                    created_at: row.get(6)?,
                    search_rowid: row.get(7)?,
                    score: row.get(8)?,
                    snippet: row.get(9)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let more = rows.len() > limit;
        let page = rows.into_iter().take(limit).collect::<Vec<_>>();
        let next_cursor = if more {
            page.last().map(|last| {
                encode_cursor(SearchCursor {
                    score: last.score,
                    created_at: f64_to_i64(last.created_at),
                    rowid: last.search_rowid,
                })
            })
        } else {
            None
        }
        .transpose()?;
        Ok(SessionSearchPage {
            results: page
                .into_iter()
                .map(|row| SessionSearchResult {
                    project_path: row.project_path,
                    project_name: row.project_name,
                    thread_id: row.thread_id,
                    thread_title: row.thread_title,
                    turn_id: row.turn_id,
                    provider: row.provider,
                    created_at: row.created_at,
                    snippet: parse_snippet(&row.snippet),
                })
                .collect(),
            next_cursor,
        })
    }

    pub(super) fn rebuild_search_index_if_needed(&mut self) -> Result<()> {
        let ready = self
            .connection
            .query_row(
                "SELECT 1 FROM schema_migrations WHERE name = ?1",
                [SEARCH_INDEX_VERSION],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if ready {
            return Ok(());
        }

        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM session_search", [])?;
        let mut cursor = 0_i64;
        loop {
            let rows = {
                let mut statement = transaction.prepare(
                    "SELECT seq, thread_id, at, payload FROM events
                     WHERE seq > ?1 ORDER BY seq LIMIT 5000",
                )?;
                statement
                    .query_map([cursor], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, String>(3)?,
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            };
            if rows.is_empty() {
                break;
            }
            for (seq, thread_id, at, payload) in &rows {
                let event = serde_json::from_str::<DomainEvent>(payload)?;
                index_event(&transaction, *seq, thread_id, *at, &event)?;
            }
            cursor = rows.last().map_or(cursor, |row| row.0);
        }
        transaction.execute(
            "INSERT OR REPLACE INTO schema_migrations (name) VALUES (?1)",
            [SEARCH_INDEX_VERSION],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn usage_summary(&self, thread_id: &str, since: i64) -> Result<UsageSummary> {
        let Some(thread) = self.thread(thread_id)? else {
            return Ok(UsageSummary {
                session: empty_usage(),
                today: empty_usage(),
            });
        };
        let mut session = empty_usage();
        let mut previous = None;
        {
            let mut statement = self.connection.prepare(
                "SELECT payload FROM events
                 WHERE thread_id = ?1 AND payload LIKE '%\"usage.updated\"%' ORDER BY seq",
            )?;
            let rows = statement.query_map([thread_id], |row| row.get::<_, String>(0))?;
            for payload in rows {
                let Some(current) = parse_usage(&payload?)? else {
                    continue;
                };
                let increment = if thread.provider == ProviderId::ClaudeCode {
                    current.clone()
                } else {
                    usage_increment(&current, previous.as_ref())
                };
                previous = Some(current);
                session = add_usage(&session, &increment);
            }
        }

        let mut today = empty_usage();
        let mut previous_by_thread = HashMap::<String, Usage>::new();
        {
            let mut statement = self.connection.prepare(
                "SELECT e.thread_id, e.payload
                 FROM events e
                 JOIN (SELECT thread_id, MAX(seq) AS seq FROM events
                       WHERE payload LIKE '%\"usage.updated\"%' AND at < ?1 GROUP BY thread_id) last
                   ON e.thread_id = last.thread_id AND e.seq = last.seq",
            )?;
            let rows = statement.query_map([since], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (thread_id, payload) = row?;
                if let Some(usage) = parse_usage(&payload)? {
                    previous_by_thread.insert(thread_id, usage);
                }
            }
        }
        {
            let mut statement = self.connection.prepare(
                "SELECT e.thread_id, e.payload, t.provider
                 FROM events e JOIN threads t ON t.id = e.thread_id
                 WHERE e.at >= ?1 AND e.payload LIKE '%\"usage.updated\"%'
                 ORDER BY e.thread_id, e.seq",
            )?;
            let rows = statement.query_map([since], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (event_thread_id, payload, provider) = row?;
                let Some(current) = parse_usage(&payload)? else {
                    continue;
                };
                let increment = if provider == provider_key(ProviderId::ClaudeCode) {
                    current.clone()
                } else {
                    usage_increment(&current, previous_by_thread.get(&event_thread_id))
                };
                previous_by_thread.insert(event_thread_id, current);
                today = add_usage(&today, &increment);
            }
        }
        Ok(UsageSummary { session, today })
    }
}

pub(crate) fn index_event(
    connection: &rusqlite::Connection,
    seq: i64,
    thread_id: &str,
    at: i64,
    event: &DomainEvent,
) -> Result<()> {
    let Some(entry) = searchable_entry(event) else {
        return Ok(());
    };
    connection.execute(
        "INSERT INTO session_search (rowid, thread_id, event_seq, turn_id, created_at, text)
         VALUES (?1, ?2, ?1, ?3, ?4, ?5)",
        params![
            seq,
            thread_id,
            entry.turn_id,
            entry.created_at.unwrap_or(at as f64),
            entry.text
        ],
    )?;
    Ok(())
}

struct SearchEntry {
    turn_id: String,
    created_at: Option<f64>,
    text: String,
}

fn searchable_entry(event: &DomainEvent) -> Option<SearchEntry> {
    let DomainEvent::ItemCompleted { item } = event else {
        return None;
    };
    let text = match item.item_type {
        ItemType::Message | ItemType::ToolCall | ItemType::Error => item.text.clone(),
        ItemType::Command => {
            let text = [item.command.as_deref(), item.text.as_deref()]
                .into_iter()
                .flatten()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            Some(text)
        }
        ItemType::Reasoning | ItemType::FileChange | ItemType::Plan | ItemType::Unknown => None,
    }?;
    if text.trim().is_empty() {
        return None;
    }
    Some(SearchEntry {
        turn_id: item.turn_id.clone(),
        created_at: Some(item.created_at),
        text,
    })
}

fn to_fts_query(query: &str) -> Result<String> {
    let terms = query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err(StoreError::EmptySearchQuery);
    }
    Ok(terms.join(" "))
}

fn encode_cursor(cursor: SearchCursor) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor)?))
}

fn decode_cursor(cursor: Option<&str>) -> Option<SearchCursor> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor?).ok()?;
    let value = serde_json::from_slice::<SearchCursor>(&bytes).ok()?;
    (value.score.is_finite() && value.created_at >= 0 && value.rowid >= 1).then_some(value)
}

fn parse_snippet(value: &str) -> Vec<SearchSnippetPart> {
    let mut parts = Vec::<SearchSnippetPart>::new();
    let mut highlighted = false;
    let mut text = String::new();
    let push = |parts: &mut Vec<SearchSnippetPart>, text: &mut String, highlighted| {
        if text.is_empty() {
            return;
        }
        if let Some(previous) = parts.last_mut()
            && previous.highlighted == highlighted
        {
            previous.text.push_str(text);
            text.clear();
        } else {
            parts.push(SearchSnippetPart {
                text: std::mem::take(text),
                highlighted,
            });
        }
    };
    for character in value.chars() {
        if matches!(character, SNIPPET_START | SNIPPET_END) {
            push(&mut parts, &mut text, highlighted);
            highlighted = character == SNIPPET_START;
        } else {
            text.push(character);
        }
    }
    push(&mut parts, &mut text, highlighted);
    if parts.is_empty() {
        vec![SearchSnippetPart {
            text: value.into(),
            highlighted: false,
        }]
    } else {
        parts
    }
}

fn parse_usage(payload: &str) -> Result<Option<Usage>> {
    match serde_json::from_str::<DomainEvent>(payload)? {
        DomainEvent::UsageUpdated { mut usage } => {
            usage.context_window = None;
            Ok(Some(usage))
        }
        _ => Ok(None),
    }
}

fn empty_usage() -> Usage {
    Usage {
        input_tokens: 0.0,
        cached_input_tokens: 0.0,
        output_tokens: 0.0,
        reasoning_tokens: 0.0,
        total_tokens: 0.0,
        cost_usd: None,
        context_window: None,
    }
}

fn add_usage(left: &Usage, right: &Usage) -> Usage {
    Usage {
        input_tokens: left.input_tokens + right.input_tokens,
        cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
        output_tokens: left.output_tokens + right.output_tokens,
        reasoning_tokens: left.reasoning_tokens + right.reasoning_tokens,
        total_tokens: left.total_tokens + right.total_tokens,
        cost_usd: (left.cost_usd.is_some() || right.cost_usd.is_some())
            .then_some(left.cost_usd.unwrap_or(0.0) + right.cost_usd.unwrap_or(0.0)),
        context_window: None,
    }
}

fn usage_increment(current: &Usage, previous: Option<&Usage>) -> Usage {
    let empty = empty_usage();
    let previous = previous.unwrap_or(&empty);
    let delta = |now: f64, before: f64| if now >= before { now - before } else { now };
    Usage {
        input_tokens: delta(current.input_tokens, previous.input_tokens),
        cached_input_tokens: delta(current.cached_input_tokens, previous.cached_input_tokens),
        output_tokens: delta(current.output_tokens, previous.output_tokens),
        reasoning_tokens: delta(current.reasoning_tokens, previous.reasoning_tokens),
        total_tokens: delta(current.total_tokens, previous.total_tokens),
        cost_usd: current
            .cost_usd
            .map(|cost| delta(cost, previous.cost_usd.unwrap_or(0.0))),
        context_window: None,
    }
}

fn store_conversion_error(error: StoreError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn u64_to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn f64_to_i64(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    value.clamp(0.0, i64::MAX as f64) as i64
}
