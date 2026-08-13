pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
  path       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  project_path TEXT NOT NULL,
  provider     TEXT NOT NULL,
  agent        TEXT,
  connection_id TEXT,
  title        TEXT NOT NULL,
  pinned       INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  worktree_path   TEXT,
  worktree_branch TEXT,
  lifecycle_state  TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_state IN ('active', 'settled', 'snoozed')),
  lifecycle_at     INTEGER,
  lifecycle_reason TEXT,
  wake_at          INTEGER,
  keep_active      INTEGER NOT NULL DEFAULT 0,
  woke_at          INTEGER,
  unread           INTEGER NOT NULL DEFAULT 0,
  last_active_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sidebar_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  mode             TEXT NOT NULL CHECK (mode IN ('classic', 'inbox')),
  auto_settle_days INTEGER CHECK (auto_settle_days BETWEEN 1 AND 90)
);

INSERT OR IGNORE INTO sidebar_settings (id, mode, auto_settle_days) VALUES (1, 'inbox', 3);

CREATE TABLE IF NOT EXISTS events (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  payload   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checkpoints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  label      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS restore_undos (
  token            TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL UNIQUE,
  checkpoint_seq   INTEGER NOT NULL,
  snapshot_commit  TEXT NOT NULL,
  events_json      TEXT NOT NULL,
  checkpoints_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_session_states (
  thread_id  TEXT PRIMARY KEY,
  state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_search USING fts5 (
  thread_id UNINDEXED,
  event_seq UNINDEXED,
  turn_id UNINDEXED,
  created_at UNINDEXED,
  text,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS diff_decisions (
  thread_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision  TEXT NOT NULL CHECK (decision IN ('accept', 'reject')),
  PRIMARY KEY (thread_id, target_id)
);

CREATE TABLE IF NOT EXISTS design_runs (
  thread_id TEXT PRIMARY KEY,
  payload   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS checkpoints_by_thread ON checkpoints (thread_id, seq);
CREATE INDEX IF NOT EXISTS events_by_thread ON events (thread_id, seq);
CREATE INDEX IF NOT EXISTS threads_by_project ON threads (project_path);
"#;

pub(crate) struct AddedColumn {
    pub(crate) table: &'static str,
    pub(crate) column: &'static str,
    pub(crate) definition: &'static str,
}

pub(crate) const ADDED_COLUMNS: &[AddedColumn] = &[
    AddedColumn {
        table: "projects",
        column: "pinned",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    AddedColumn {
        table: "threads",
        column: "pinned",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    AddedColumn {
        table: "threads",
        column: "connection_id",
        definition: "TEXT",
    },
    AddedColumn {
        table: "threads",
        column: "worktree_path",
        definition: "TEXT",
    },
    AddedColumn {
        table: "threads",
        column: "worktree_branch",
        definition: "TEXT",
    },
    AddedColumn {
        table: "threads",
        column: "lifecycle_state",
        definition: "TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'settled', 'snoozed'))",
    },
    AddedColumn {
        table: "threads",
        column: "lifecycle_at",
        definition: "INTEGER",
    },
    AddedColumn {
        table: "threads",
        column: "lifecycle_reason",
        definition: "TEXT",
    },
    AddedColumn {
        table: "threads",
        column: "wake_at",
        definition: "INTEGER",
    },
    AddedColumn {
        table: "threads",
        column: "keep_active",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    AddedColumn {
        table: "threads",
        column: "woke_at",
        definition: "INTEGER",
    },
    AddedColumn {
        table: "threads",
        column: "unread",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
    AddedColumn {
        table: "threads",
        column: "last_active_at",
        definition: "INTEGER NOT NULL DEFAULT 0",
    },
];
