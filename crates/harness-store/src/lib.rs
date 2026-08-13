mod checkpoints;
mod events;
mod schema;

pub use checkpoints::{NewCheckpoint, RestoreUndo, StoredCheckpoint};
pub use events::{SearchOptions, UsageSummary};

use harness_protocol::{
    DiffDecision, PairedDevice, ProviderId, SettleReason, SidebarMode, SidebarSettings,
    ThreadLifecycle,
};
use rusqlite::{Connection, OptionalExtension as _, Row, params};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

use schema::{ADDED_COLUMNS, SCHEMA};

#[derive(Debug, Error)]
pub enum StoreError {
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("thread not found")]
    ThreadNotFound,
    #[error("discard the isolated session checkout before deleting it")]
    IsolatedCheckout,
    #[error("unknown provider in stored thread: {0}")]
    UnknownProvider(String),
    #[error("invalid lifecycle in stored thread: {0}")]
    InvalidLifecycle(String),
    #[error("database path has no parent directory")]
    MissingParent,
    #[error("system clock is before the Unix epoch")]
    InvalidClock,
    #[error("search query cannot be empty")]
    EmptySearchQuery,
    #[error("restore can no longer be undone")]
    RestoreUnavailable,
    #[error("restore can only be undone before the session continues")]
    RestoreContinued,
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredProject {
    pub path: String,
    pub name: String,
    pub pinned: bool,
    pub created_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoredThread {
    pub id: String,
    pub project_path: String,
    pub provider: ProviderId,
    pub agent: Option<String>,
    pub title: String,
    pub pinned: bool,
    pub created_at: i64,
    pub closed_at: Option<i64>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
    pub lifecycle: ThreadLifecycle,
    pub unread: bool,
    pub last_active_at: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewThread {
    pub id: String,
    pub project_path: String,
    pub provider: ProviderId,
    pub agent: Option<String>,
    pub title: String,
    pub created_at: Option<i64>,
    pub worktree_path: Option<String>,
    pub worktree_branch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredWorktree {
    pub thread_id: String,
    pub path: String,
    pub branch: String,
    pub repo_path: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SidebarSettingsUpdate {
    pub mode: Option<SidebarMode>,
    pub auto_settle_days: Option<Option<u8>>,
}

pub struct Store {
    pub(crate) connection: Connection,
}

impl Store {
    pub fn open(location: impl AsRef<Path>) -> Result<Self> {
        let location = location.as_ref();
        if location != Path::new(":memory:") {
            let parent = location.parent().ok_or(StoreError::MissingParent)?;
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(location)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )?;
        connection.execute_batch(SCHEMA)?;
        let mut store = Self { connection };
        store.migrate()?;
        store.rebuild_search_index_if_needed()?;
        Ok(store)
    }

    pub fn memory() -> Result<Self> {
        Self::open(":memory:")
    }

    pub fn close(self) -> Result<()> {
        self.connection
            .close()
            .map_err(|(_connection, error)| StoreError::Sql(error))
    }

    pub fn mobile_access_enabled(&self) -> Result<bool> {
        let value = self
            .connection
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'mobile_access_enabled'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("true"))
    }

    pub fn set_mobile_access_enabled(&self, enabled: bool) -> Result<()> {
        self.connection.execute(
            "INSERT INTO app_settings (key, value) VALUES ('mobile_access_enabled', ?1)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [if enabled { "true" } else { "false" }],
        )?;
        Ok(())
    }

    pub fn pair_device(&self, name: &str, token_hash: &str) -> Result<PairedDevice> {
        self.pair_device_at(name, token_hash, as_u64(now_ms()?))
    }

    pub fn pair_device_at(&self, name: &str, token_hash: &str, at: u64) -> Result<PairedDevice> {
        let device = PairedDevice {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            created_at: at,
            last_seen_at: at,
        };
        self.connection.execute(
            "INSERT INTO paired_devices (id, name, token_hash, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![
                device.id,
                device.name,
                token_hash,
                as_i64(device.created_at)
            ],
        )?;
        Ok(device)
    }

    pub fn paired_devices(&self) -> Result<Vec<PairedDevice>> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, created_at, last_seen_at FROM paired_devices ORDER BY created_at",
        )?;
        statement
            .query_map([], row_to_paired_device)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn has_paired_device(&self, id: &str) -> Result<bool> {
        self.connection
            .query_row("SELECT 1 FROM paired_devices WHERE id = ?1", [id], |_| {
                Ok(())
            })
            .optional()
            .map(|row| row.is_some())
            .map_err(Into::into)
    }

    pub fn paired_device_for_token_hash(&self, token_hash: &str) -> Result<Option<PairedDevice>> {
        self.connection
            .query_row(
                "SELECT id, name, created_at, last_seen_at
                 FROM paired_devices WHERE token_hash = ?1",
                [token_hash],
                row_to_paired_device,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn touch_paired_device(&self, id: &str) -> Result<()> {
        self.touch_paired_device_at(id, as_u64(now_ms()?))
    }

    pub fn touch_paired_device_at(&self, id: &str, at: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE paired_devices SET last_seen_at = ?1 WHERE id = ?2",
            params![as_i64(at), id],
        )?;
        Ok(())
    }

    pub fn revoke_paired_device(&self, id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM paired_devices WHERE id = ?1", [id])?;
        Ok(())
    }

    fn migrate(&self) -> Result<()> {
        for added in ADDED_COLUMNS {
            let mut statement = self
                .connection
                .prepare(&format!("PRAGMA table_info({})", added.table))?;
            let columns = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            if columns.iter().any(|column| column == added.column) {
                continue;
            }
            self.connection.execute_batch(&format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                added.table, added.column, added.definition
            ))?;
        }
        self.connection.execute(
            "UPDATE threads SET last_active_at = created_at WHERE last_active_at = 0",
            [],
        )?;
        Ok(())
    }

    pub fn add_project(&self, project_path: &str, name: Option<&str>) -> Result<StoredProject> {
        let created_at = now_ms()?;
        let inferred_name = Path::new(project_path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(project_path);
        self.connection.execute(
            "INSERT INTO projects (path, name, pinned, created_at) VALUES (?1, ?2, 0, ?3)
             ON CONFLICT (path) DO NOTHING",
            params![project_path, name.unwrap_or(inferred_name), created_at],
        )?;
        Ok(self.project(project_path)?.unwrap_or(StoredProject {
            path: project_path.into(),
            name: name.unwrap_or(inferred_name).into(),
            pinned: false,
            created_at,
        }))
    }

    pub fn set_project_pinned(&self, project_path: &str, pinned: bool) -> Result<()> {
        self.connection.execute(
            "UPDATE projects SET pinned = ?1 WHERE path = ?2",
            params![bool_i64(pinned), project_path],
        )?;
        Ok(())
    }

    pub fn project(&self, project_path: &str) -> Result<Option<StoredProject>> {
        self.connection
            .query_row(
                "SELECT path, name, pinned, created_at FROM projects WHERE path = ?1",
                [project_path],
                row_to_project,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn projects(&self) -> Result<Vec<StoredProject>> {
        let mut statement = self
            .connection
            .prepare("SELECT path, name, pinned, created_at FROM projects ORDER BY created_at")?;
        statement
            .query_map([], row_to_project)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn rename_project(&self, project_path: &str, name: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE projects SET name = ?1 WHERE path = ?2",
            params![name, project_path],
        )?;
        Ok(())
    }

    pub fn remove_project(&self, project_path: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM projects WHERE path = ?1", [project_path])?;
        Ok(())
    }

    pub fn add_thread(&self, thread: NewThread) -> Result<StoredThread> {
        self.add_thread_with_connection(thread, None)
    }

    pub fn add_thread_with_connection(
        &self,
        thread: NewThread,
        connection_id: Option<&str>,
    ) -> Result<StoredThread> {
        let created_at = thread.created_at.unwrap_or(now_ms()?);
        self.connection.execute(
            "INSERT INTO threads
               (id, project_path, provider, agent, connection_id, title, created_at,
                worktree_path, worktree_branch, lifecycle_state, keep_active, unread,
                last_active_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', 0, 0, ?7)",
            params![
                thread.id,
                thread.project_path,
                provider_key(thread.provider),
                thread.agent,
                connection_id,
                thread.title,
                created_at,
                thread.worktree_path,
                thread.worktree_branch,
            ],
        )?;
        Ok(StoredThread {
            id: thread.id,
            project_path: thread.project_path,
            provider: thread.provider,
            agent: thread.agent,
            title: thread.title,
            pinned: false,
            created_at,
            closed_at: None,
            worktree_path: thread.worktree_path,
            worktree_branch: thread.worktree_branch,
            lifecycle: ThreadLifecycle::Active {
                keep_active: false,
                woke_at: None,
            },
            unread: false,
            last_active_at: created_at,
        })
    }

    pub fn thread_connection_id(&self, thread_id: &str) -> Result<Option<String>> {
        self.connection
            .query_row(
                "SELECT connection_id FROM threads WHERE id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or(StoreError::ThreadNotFound)
    }

    pub fn set_provider_session_state(&self, thread_id: &str, state: &Value) -> Result<()> {
        if self.thread(thread_id)?.is_none() {
            return Err(StoreError::ThreadNotFound);
        }
        self.connection.execute(
            "INSERT INTO provider_session_states (thread_id, state_json) VALUES (?1, ?2)
             ON CONFLICT (thread_id) DO UPDATE SET state_json = excluded.state_json",
            params![thread_id, serde_json::to_string(state)?],
        )?;
        Ok(())
    }

    pub fn provider_session_state(&self, thread_id: &str) -> Result<Option<Value>> {
        let state: Option<String> = self
            .connection
            .query_row(
                "SELECT state_json FROM provider_session_states WHERE thread_id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()?;
        state
            .map(|state| serde_json::from_str(&state))
            .transpose()
            .map_err(Into::into)
    }

    pub fn worktrees(&self) -> Result<Vec<StoredWorktree>> {
        let mut statement = self.connection.prepare(
            "SELECT id, project_path, worktree_path, worktree_branch FROM threads
             WHERE worktree_path IS NOT NULL",
        )?;
        statement
            .query_map([], |row| {
                Ok(StoredWorktree {
                    thread_id: row.get(0)?,
                    repo_path: row.get(1)?,
                    path: row.get(2)?,
                    branch: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn forget_worktree(&self, thread_id: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE threads SET worktree_path = NULL, worktree_branch = NULL WHERE id = ?1",
            [thread_id],
        )?;
        Ok(())
    }

    pub fn thread(&self, id: &str) -> Result<Option<StoredThread>> {
        let row = self
            .connection
            .query_row(THREAD_SELECT_BY_ID, [id], row_to_thread)
            .optional()?;
        row.transpose()
    }

    pub fn threads(&self, project_path: Option<&str>) -> Result<Vec<StoredThread>> {
        let (sql, project) = match project_path {
            Some(path) => (
                format!("{THREAD_SELECT} WHERE project_path = ?1 ORDER BY created_at DESC"),
                Some(path),
            ),
            None => (format!("{THREAD_SELECT} ORDER BY created_at DESC"), None),
        };
        let mut statement = self.connection.prepare(&sql)?;
        let rows = match project {
            Some(path) => statement.query_map([path], row_to_thread)?,
            None => statement.query_map([], row_to_thread)?,
        };
        rows.map(|row| row.and_then(identity_sql_result))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn rename_thread(&self, id: &str, title: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE threads SET title = ?1 WHERE id = ?2",
            params![title, id],
        )?;
        Ok(())
    }

    pub fn set_thread_pinned(&self, id: &str, pinned: bool) -> Result<()> {
        self.connection.execute(
            "UPDATE threads SET pinned = ?1 WHERE id = ?2",
            params![bool_i64(pinned), id],
        )?;
        Ok(())
    }

    pub fn settle_thread(
        &self,
        id: &str,
        reason: SettleReason,
        at: Option<i64>,
    ) -> Result<ThreadLifecycle> {
        let at = at.unwrap_or(now_ms()?);
        self.update_thread(
            "UPDATE threads SET lifecycle_state = 'settled', lifecycle_at = ?1,
             lifecycle_reason = ?2, wake_at = NULL, keep_active = 0, woke_at = NULL
             WHERE id = ?3",
            params![at, settle_reason_key(reason), id],
        )?;
        Ok(ThreadLifecycle::Settled {
            settled_at: as_u64(at),
            reason,
        })
    }

    pub fn snooze_thread(
        &self,
        id: &str,
        wake_at: i64,
        at: Option<i64>,
    ) -> Result<ThreadLifecycle> {
        let at = at.unwrap_or(now_ms()?);
        self.update_thread(
            "UPDATE threads SET lifecycle_state = 'snoozed', lifecycle_at = ?1,
             lifecycle_reason = NULL, wake_at = ?2, keep_active = 0, woke_at = NULL
             WHERE id = ?3",
            params![at, wake_at, id],
        )?;
        Ok(ThreadLifecycle::Snoozed {
            snoozed_at: as_u64(at),
            wake_at: as_u64(wake_at),
        })
    }

    pub fn activate_thread(&self, id: &str, at: Option<i64>) -> Result<ThreadLifecycle> {
        let at = at.unwrap_or(now_ms()?);
        let before = self.thread(id)?.ok_or(StoreError::ThreadNotFound)?;
        let (keep_active, woke_at) = match before.lifecycle {
            ThreadLifecycle::Active {
                keep_active,
                woke_at,
            } => (keep_active, woke_at.map(|value| value as i64)),
            ThreadLifecycle::Settled { .. } | ThreadLifecycle::Snoozed { .. } => (false, Some(at)),
        };
        self.connection.execute(
            "UPDATE threads SET lifecycle_state = 'active', lifecycle_at = NULL,
             lifecycle_reason = NULL, wake_at = NULL, woke_at = ?1 WHERE id = ?2",
            params![woke_at, id],
        )?;
        Ok(ThreadLifecycle::Active {
            keep_active,
            woke_at: woke_at.map(as_u64),
        })
    }

    pub fn set_thread_keep_active(
        &self,
        id: &str,
        keep_active: bool,
        at: Option<i64>,
    ) -> Result<ThreadLifecycle> {
        let lifecycle = self.activate_thread(id, at)?;
        self.connection.execute(
            "UPDATE threads SET keep_active = ?1 WHERE id = ?2",
            params![bool_i64(keep_active), id],
        )?;
        let woke_at = match lifecycle {
            ThreadLifecycle::Active { woke_at, .. } => woke_at,
            ThreadLifecycle::Settled { .. } | ThreadLifecycle::Snoozed { .. } => None,
        };
        Ok(ThreadLifecycle::Active {
            keep_active,
            woke_at,
        })
    }

    pub fn touch_thread(&self, id: &str, unread: bool, at: Option<i64>) -> Result<ThreadLifecycle> {
        let at = at.unwrap_or(now_ms()?);
        let lifecycle = self.activate_thread(id, Some(at))?;
        self.connection.execute(
            "UPDATE threads SET last_active_at = ?1, unread = MAX(unread, ?2) WHERE id = ?3",
            params![at, bool_i64(unread), id],
        )?;
        Ok(lifecycle)
    }

    pub fn mark_thread_read(&self, id: &str) -> Result<()> {
        self.update_thread(
            "UPDATE threads SET unread = 0, woke_at = NULL WHERE id = ?1",
            [id],
        )
    }

    pub fn due_snoozed_threads(&self, now: i64) -> Result<Vec<StoredThread>> {
        self.query_threads(
            "WHERE closed_at IS NULL AND lifecycle_state = 'snoozed' AND wake_at <= ?1
             ORDER BY wake_at",
            now,
        )
    }

    pub fn inactive_threads(&self, cutoff: i64) -> Result<Vec<StoredThread>> {
        self.query_threads(
            "WHERE closed_at IS NULL AND lifecycle_state = 'active' AND keep_active = 0
             AND last_active_at <= ?1 ORDER BY last_active_at",
            cutoff,
        )
    }

    fn query_threads(&self, suffix: &str, value: i64) -> Result<Vec<StoredThread>> {
        let mut statement = self
            .connection
            .prepare(&format!("{THREAD_SELECT} {suffix}"))?;
        statement
            .query_map([value], row_to_thread)?
            .map(|row| row.and_then(identity_sql_result))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn sidebar_settings(&self) -> Result<SidebarSettings> {
        self.connection
            .query_row(
                "SELECT mode, auto_settle_days FROM sidebar_settings WHERE id = 1",
                [],
                |row| {
                    let mode: String = row.get(0)?;
                    let mode = match mode.as_str() {
                        "classic" => SidebarMode::Classic,
                        "inbox" => SidebarMode::Inbox,
                        _ => return Err(invalid_column("mode", mode)),
                    };
                    Ok(SidebarSettings {
                        mode,
                        auto_settle_days: row.get(1)?,
                    })
                },
            )
            .map_err(Into::into)
    }

    pub fn update_sidebar_settings(
        &self,
        update: SidebarSettingsUpdate,
    ) -> Result<SidebarSettings> {
        let current = self.sidebar_settings()?;
        let next = SidebarSettings {
            mode: update.mode.unwrap_or(current.mode),
            auto_settle_days: update.auto_settle_days.unwrap_or(current.auto_settle_days),
        };
        self.connection.execute(
            "UPDATE sidebar_settings SET mode = ?1, auto_settle_days = ?2 WHERE id = 1",
            params![sidebar_mode_key(next.mode), next.auto_settle_days],
        )?;
        Ok(next)
    }

    pub fn close_thread(&self, id: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE threads SET closed_at = ?1 WHERE id = ?2",
            params![now_ms()?, id],
        )?;
        Ok(())
    }

    pub fn delete_thread(&mut self, id: &str) -> Result<()> {
        if self
            .thread(id)?
            .is_some_and(|thread| thread.worktree_path.is_some())
        {
            return Err(StoreError::IsolatedCheckout);
        }
        let transaction = self.connection.transaction()?;
        for table in [
            "session_search",
            "events",
            "checkpoints",
            "restore_undos",
            "provider_session_states",
            "diff_decisions",
            "design_runs",
        ] {
            transaction.execute(&format!("DELETE FROM {table} WHERE thread_id = ?1"), [id])?;
        }
        transaction.execute("DELETE FROM threads WHERE id = ?1", [id])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn set_design_run(&self, thread_id: &str, payload: &Value) -> Result<()> {
        self.connection.execute(
            "INSERT INTO design_runs (thread_id, payload) VALUES (?1, ?2)
             ON CONFLICT (thread_id) DO UPDATE SET payload = excluded.payload",
            params![thread_id, serde_json::to_string(payload)?],
        )?;
        Ok(())
    }

    pub fn design_run(&self, thread_id: &str) -> Result<Option<Value>> {
        let payload: Option<String> = self
            .connection
            .query_row(
                "SELECT payload FROM design_runs WHERE thread_id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()?;
        payload
            .map(|payload| serde_json::from_str(&payload))
            .transpose()
            .map_err(Into::into)
    }

    pub fn delete_design_run(&self, thread_id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM design_runs WHERE thread_id = ?1", [thread_id])?;
        Ok(())
    }

    pub fn set_diff_decision(
        &self,
        thread_id: &str,
        target_id: &str,
        decision: DiffDecision,
    ) -> Result<()> {
        self.connection.execute(
            "INSERT INTO diff_decisions (thread_id, target_id, decision) VALUES (?1, ?2, ?3)
             ON CONFLICT (thread_id, target_id) DO UPDATE SET decision = excluded.decision",
            params![thread_id, target_id, diff_decision_key(decision)],
        )?;
        Ok(())
    }

    pub fn diff_decision(&self, thread_id: &str, target_id: &str) -> Result<Option<DiffDecision>> {
        let decision: Option<String> = self
            .connection
            .query_row(
                "SELECT decision FROM diff_decisions WHERE thread_id = ?1 AND target_id = ?2",
                params![thread_id, target_id],
                |row| row.get(0),
            )
            .optional()?;
        decision
            .map(|decision| match decision.as_str() {
                "accept" => Ok(DiffDecision::Accept),
                "reject" => Ok(DiffDecision::Reject),
                _ => Err(StoreError::InvalidLifecycle(decision)),
            })
            .transpose()
    }

    pub fn diff_decisions(&self, thread_id: &str) -> Result<HashMap<String, DiffDecision>> {
        let mut statement = self
            .connection
            .prepare("SELECT target_id, decision FROM diff_decisions WHERE thread_id = ?1")?;
        statement
            .query_map([thread_id], |row| {
                let target: String = row.get(0)?;
                let decision: String = row.get(1)?;
                Ok((target, decision))
            })?
            .map(|row| {
                let (target, decision) = row?;
                let decision = match decision.as_str() {
                    "accept" => DiffDecision::Accept,
                    "reject" => DiffDecision::Reject,
                    _ => return Err(StoreError::InvalidLifecycle(decision)),
                };
                Ok((target, decision))
            })
            .collect()
    }

    fn update_thread<P: rusqlite::Params>(&self, sql: &str, parameters: P) -> Result<()> {
        if self.connection.execute(sql, parameters)? == 0 {
            return Err(StoreError::ThreadNotFound);
        }
        Ok(())
    }
}

const THREAD_SELECT: &str = "SELECT id, project_path, provider, agent, title, pinned, created_at,
    closed_at, worktree_path, worktree_branch, lifecycle_state, lifecycle_at,
    lifecycle_reason, wake_at, keep_active, woke_at, unread, last_active_at FROM threads";
const THREAD_SELECT_BY_ID: &str = "SELECT id, project_path, provider, agent, title, pinned,
    created_at, closed_at, worktree_path, worktree_branch, lifecycle_state, lifecycle_at,
    lifecycle_reason, wake_at, keep_active, woke_at, unread, last_active_at
    FROM threads WHERE id = ?1";

fn row_to_project(row: &Row<'_>) -> rusqlite::Result<StoredProject> {
    Ok(StoredProject {
        path: row.get(0)?,
        name: row.get(1)?,
        pinned: row.get::<_, i64>(2)? == 1,
        created_at: row.get(3)?,
    })
}

fn row_to_paired_device(row: &Row<'_>) -> rusqlite::Result<PairedDevice> {
    Ok(PairedDevice {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: as_u64(row.get(2)?),
        last_seen_at: as_u64(row.get(3)?),
    })
}

fn row_to_thread(row: &Row<'_>) -> rusqlite::Result<Result<StoredThread>> {
    let provider: String = row.get(2)?;
    let lifecycle_state: String = row.get(10)?;
    let created_at: i64 = row.get(6)?;
    let lifecycle_at: Option<i64> = row.get(11)?;
    let lifecycle_reason: Option<String> = row.get(12)?;
    let wake_at: Option<i64> = row.get(13)?;
    let keep_active = row.get::<_, i64>(14)? == 1;
    let woke_at: Option<i64> = row.get(15)?;
    let lifecycle = match lifecycle_state.as_str() {
        "active" => ThreadLifecycle::Active {
            keep_active,
            woke_at: woke_at.map(as_u64),
        },
        "settled" => {
            let reason = match parse_settle_reason(lifecycle_reason.as_deref().unwrap_or("manual"))
            {
                Ok(reason) => reason,
                Err(error) => return Ok(Err(error)),
            };
            ThreadLifecycle::Settled {
                settled_at: as_u64(lifecycle_at.unwrap_or(created_at)),
                reason,
            }
        }
        "snoozed" => ThreadLifecycle::Snoozed {
            snoozed_at: as_u64(lifecycle_at.unwrap_or(created_at)),
            wake_at: as_u64(wake_at.unwrap_or(created_at)),
        },
        _ => return Ok(Err(StoreError::InvalidLifecycle(lifecycle_state))),
    };
    let provider = match parse_provider(&provider) {
        Ok(provider) => provider,
        Err(error) => return Ok(Err(error)),
    };
    Ok(Ok(StoredThread {
        id: row.get(0)?,
        project_path: row.get(1)?,
        provider,
        agent: row.get(3)?,
        title: row.get(4)?,
        pinned: row.get::<_, i64>(5)? == 1,
        created_at,
        closed_at: row.get(7)?,
        worktree_path: row.get(8)?,
        worktree_branch: row.get(9)?,
        lifecycle,
        unread: row.get::<_, i64>(16)? == 1,
        last_active_at: row.get(17)?,
    }))
}

fn identity_sql_result<T>(result: Result<T>) -> rusqlite::Result<T> {
    result.map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn invalid_column(column: &str, value: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        format!("invalid {column}: {value}").into(),
    )
}

fn parse_provider(value: &str) -> Result<ProviderId> {
    match value {
        "codex" => Ok(ProviderId::Codex),
        "claude-code" => Ok(ProviderId::ClaudeCode),
        "grok" => Ok(ProviderId::Grok),
        "cursor" => Ok(ProviderId::Cursor),
        "opencode" => Ok(ProviderId::OpenCode),
        "antigravity" => Ok(ProviderId::Antigravity),
        "acp" => Ok(ProviderId::Acp),
        "api" => Ok(ProviderId::Api),
        _ => Err(StoreError::UnknownProvider(value.into())),
    }
}

fn provider_key(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Codex => "codex",
        ProviderId::ClaudeCode => "claude-code",
        ProviderId::Grok => "grok",
        ProviderId::Cursor => "cursor",
        ProviderId::OpenCode => "opencode",
        ProviderId::Antigravity => "antigravity",
        ProviderId::Acp => "acp",
        ProviderId::Api => "api",
    }
}

fn sidebar_mode_key(mode: SidebarMode) -> &'static str {
    match mode {
        SidebarMode::Classic => "classic",
        SidebarMode::Inbox => "inbox",
    }
}

fn settle_reason_key(reason: SettleReason) -> &'static str {
    match reason {
        SettleReason::Manual => "manual",
        SettleReason::Inactivity => "inactivity",
        SettleReason::ChangeRequest => "change_request",
    }
}

fn parse_settle_reason(reason: &str) -> Result<SettleReason> {
    match reason {
        "manual" => Ok(SettleReason::Manual),
        "inactivity" => Ok(SettleReason::Inactivity),
        "change_request" => Ok(SettleReason::ChangeRequest),
        _ => Err(StoreError::InvalidLifecycle(reason.into())),
    }
}

fn diff_decision_key(decision: DiffDecision) -> &'static str {
    match decision {
        DiffDecision::Accept => "accept",
        DiffDecision::Reject => "reject",
    }
}

fn bool_i64(value: bool) -> i64 {
    i64::from(value)
}

fn as_u64(value: i64) -> u64 {
    value.max(0) as u64
}

fn as_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn now_ms() -> Result<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::InvalidClock)?
        .as_millis();
    Ok(i64::try_from(millis).unwrap_or(i64::MAX))
}

#[cfg(test)]
mod tests;
