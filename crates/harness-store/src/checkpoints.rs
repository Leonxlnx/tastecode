use super::{Result, Store, StoreError, now_ms};
use crate::events::index_event;
use harness_protocol::DomainEvent;
use rusqlite::{OptionalExtension as _, Row, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewCheckpoint {
    pub thread_id: String,
    pub seq: u64,
    pub commit: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredCheckpoint {
    pub id: u64,
    pub thread_id: String,
    pub seq: u64,
    pub commit: String,
    pub label: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestoreUndo {
    pub commit: String,
}

#[derive(Serialize, Deserialize)]
struct EventRow {
    seq: i64,
    thread_id: String,
    at: i64,
    payload: String,
}

#[derive(Serialize, Deserialize)]
struct CheckpointRow {
    id: i64,
    thread_id: String,
    seq: i64,
    commit_sha: String,
    label: String,
    created_at: i64,
}

impl Store {
    pub fn add_checkpoint(&self, entry: NewCheckpoint) -> Result<StoredCheckpoint> {
        self.add_checkpoint_at(entry, now_ms()?)
    }

    pub fn add_checkpoint_at(
        &self,
        entry: NewCheckpoint,
        created_at: i64,
    ) -> Result<StoredCheckpoint> {
        self.connection.execute(
            "INSERT INTO checkpoints (thread_id, seq, commit_sha, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                entry.thread_id,
                u64_to_i64(entry.seq),
                entry.commit,
                entry.label,
                created_at
            ],
        )?;
        Ok(StoredCheckpoint {
            id: self.connection.last_insert_rowid().max(0) as u64,
            thread_id: entry.thread_id,
            seq: entry.seq,
            commit: entry.commit,
            label: entry.label,
            created_at,
        })
    }

    pub fn checkpoints(&self, thread_id: &str) -> Result<Vec<StoredCheckpoint>> {
        let mut statement = self.connection.prepare(
            "SELECT id, thread_id, seq, commit_sha, label, created_at
             FROM checkpoints WHERE thread_id = ?1 ORDER BY seq",
        )?;
        statement
            .query_map([thread_id], row_to_checkpoint)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn checkpoint(&self, id: u64) -> Result<Option<StoredCheckpoint>> {
        self.connection
            .query_row(
                "SELECT id, thread_id, seq, commit_sha, label, created_at
                 FROM checkpoints WHERE id = ?1",
                [u64_to_i64(id)],
                row_to_checkpoint,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_restore_undo(&mut self, thread_id: &str, seq: u64, commit: &str) -> Result<String> {
        let events = {
            let mut statement = self.connection.prepare(
                "SELECT seq, thread_id, at, payload FROM events
                 WHERE thread_id = ?1 AND seq > ?2 ORDER BY seq",
            )?;
            statement
                .query_map(params![thread_id, u64_to_i64(seq)], |row| {
                    Ok(EventRow {
                        seq: row.get(0)?,
                        thread_id: row.get(1)?,
                        at: row.get(2)?,
                        payload: row.get(3)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let checkpoints = {
            let mut statement = self.connection.prepare(
                "SELECT id, thread_id, seq, commit_sha, label, created_at FROM checkpoints
                 WHERE thread_id = ?1 AND seq > ?2 ORDER BY seq",
            )?;
            statement
                .query_map(params![thread_id, u64_to_i64(seq)], |row| {
                    Ok(CheckpointRow {
                        id: row.get(0)?,
                        thread_id: row.get(1)?,
                        seq: row.get(2)?,
                        commit_sha: row.get(3)?,
                        label: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?
        };
        let token = Uuid::new_v4().to_string();
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM restore_undos WHERE thread_id = ?1",
            [thread_id],
        )?;
        transaction.execute(
            "INSERT INTO restore_undos
               (token, thread_id, checkpoint_seq, snapshot_commit, events_json, checkpoints_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                token,
                thread_id,
                u64_to_i64(seq),
                commit,
                serde_json::to_string(&events)?,
                serde_json::to_string(&checkpoints)?,
            ],
        )?;
        truncate_after(&transaction, thread_id, seq)?;
        transaction.commit()?;
        Ok(token)
    }

    pub fn restore_undo(&self, thread_id: &str, token: &str) -> Result<Option<RestoreUndo>> {
        self.connection
            .query_row(
                "SELECT snapshot_commit FROM restore_undos
                 WHERE thread_id = ?1 AND token = ?2",
                params![thread_id, token],
                |row| {
                    Ok(RestoreUndo {
                        commit: row.get(0)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn apply_restore_undo(&mut self, thread_id: &str, token: &str) -> Result<()> {
        let undo = self
            .connection
            .query_row(
                "SELECT checkpoint_seq, events_json, checkpoints_json FROM restore_undos
                 WHERE thread_id = ?1 AND token = ?2",
                params![thread_id, token],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
            .ok_or(StoreError::RestoreUnavailable)?;
        if self.last_seq(thread_id)? > undo.0.max(0) as u64 {
            return Err(StoreError::RestoreContinued);
        }
        let events = serde_json::from_str::<Vec<EventRow>>(&undo.1)?;
        let checkpoints = serde_json::from_str::<Vec<CheckpointRow>>(&undo.2)?;
        let transaction = self.connection.transaction()?;
        for event in events {
            transaction.execute(
                "INSERT INTO events (seq, thread_id, at, payload) VALUES (?1, ?2, ?3, ?4)",
                params![event.seq, event.thread_id, event.at, event.payload],
            )?;
            let domain_event = serde_json::from_str::<DomainEvent>(&event.payload)?;
            index_event(
                &transaction,
                event.seq,
                &event.thread_id,
                event.at,
                &domain_event,
            )?;
        }
        for checkpoint in checkpoints {
            transaction.execute(
                "INSERT INTO checkpoints (id, thread_id, seq, commit_sha, label, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    checkpoint.id,
                    checkpoint.thread_id,
                    checkpoint.seq,
                    checkpoint.commit_sha,
                    checkpoint.label,
                    checkpoint.created_at,
                ],
            )?;
        }
        transaction.execute("DELETE FROM restore_undos WHERE token = ?1", [token])?;
        transaction.commit()?;
        Ok(())
    }
}

fn truncate_after(connection: &rusqlite::Connection, thread_id: &str, seq: u64) -> Result<()> {
    connection.execute(
        "DELETE FROM session_search
         WHERE rowid IN (SELECT seq FROM events WHERE thread_id = ?1 AND seq > ?2)",
        params![thread_id, u64_to_i64(seq)],
    )?;
    connection.execute(
        "DELETE FROM events WHERE thread_id = ?1 AND seq > ?2",
        params![thread_id, u64_to_i64(seq)],
    )?;
    connection.execute(
        "DELETE FROM checkpoints WHERE thread_id = ?1 AND seq > ?2",
        params![thread_id, u64_to_i64(seq)],
    )?;
    Ok(())
}

fn row_to_checkpoint(row: &Row<'_>) -> rusqlite::Result<StoredCheckpoint> {
    Ok(StoredCheckpoint {
        id: row.get::<_, i64>(0)?.max(0) as u64,
        thread_id: row.get(1)?,
        seq: row.get::<_, i64>(2)?.max(0) as u64,
        commit: row.get(3)?,
        label: row.get(4)?,
        created_at: row.get(5)?,
    })
}

fn u64_to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}
