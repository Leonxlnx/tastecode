use super::*;
use harness_protocol::{DomainEvent, ItemType, Usage};
use rusqlite::{Connection, params};
use serde_json::json;

fn message(id: &str, text: &str, created_at: f64) -> DomainEvent {
    DomainEvent::ItemCompleted {
        item: harness_protocol::Item {
            id: id.into(),
            turn_id: id.into(),
            item_type: ItemType::Message,
            status: harness_protocol::ItemStatus::Completed,
            role: Some(harness_protocol::MessageRole::Assistant),
            text: Some(text.into()),
            command: None,
            exit_code: None,
            duration_ms: None,
            path: None,
            lines_added: None,
            lines_removed: None,
            created_at,
        },
    }
}

fn usage(total_tokens: f64, cost_usd: Option<f64>) -> DomainEvent {
    DomainEvent::UsageUpdated {
        usage: Usage {
            input_tokens: total_tokens,
            cached_input_tokens: 0.0,
            output_tokens: 0.0,
            reasoning_tokens: 0.0,
            total_tokens,
            cost_usd,
            context_window: None,
        },
    }
}

fn thread(id: &str, project_path: &str, provider: ProviderId) -> NewThread {
    NewThread {
        id: id.into(),
        project_path: project_path.into(),
        provider,
        agent: None,
        title: id.into(),
        created_at: None,
        worktree_path: None,
        worktree_branch: None,
    }
}

#[test]
fn projects_keep_names_pinning_and_hidden_history_owners() {
    let store = Store::memory().unwrap();
    let project = store.add_project("/home/me/work/harness", None).unwrap();
    assert_eq!(project.name, "harness");
    store.rename_project(&project.path, "My thing").unwrap();
    store.add_project(&project.path, None).unwrap();
    store.set_project_pinned(&project.path, true).unwrap();
    assert_eq!(
        store.project(&project.path).unwrap().unwrap().name,
        "My thing"
    );
    assert!(store.project(&project.path).unwrap().unwrap().pinned);

    store
        .add_thread(thread("t1", &project.path, ProviderId::Codex))
        .unwrap();
    store.remove_project(&project.path).unwrap();
    assert!(store.project(&project.path).unwrap().is_none());
    assert!(store.thread("t1").unwrap().is_some());
    store.add_project(&project.path, None).unwrap();
    assert_eq!(store.threads(Some(&project.path)).unwrap().len(), 1);
}

#[test]
fn threads_keep_provider_identity_order_and_worktree_ownership() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    let mut old = thread("old", "/repo", ProviderId::Acp);
    old.agent = Some("gemini".into());
    old.created_at = Some(1_000);
    store.add_thread(old).unwrap();
    let mut isolated = thread("isolated", "/repo", ProviderId::Codex);
    isolated.created_at = Some(2_000);
    isolated.worktree_path = Some("/trees/isolated".into());
    isolated.worktree_branch = Some("harness/isolated".into());
    store.add_thread(isolated).unwrap();

    assert_eq!(
        store
            .threads(Some("/repo"))
            .unwrap()
            .iter()
            .map(|thread| thread.id.as_str())
            .collect::<Vec<_>>(),
        ["isolated", "old"]
    );
    assert_eq!(
        store.thread("old").unwrap().unwrap().agent.as_deref(),
        Some("gemini")
    );
    assert_eq!(store.worktrees().unwrap().len(), 1);
    assert!(matches!(
        store.delete_thread("isolated"),
        Err(StoreError::IsolatedCheckout)
    ));
    store.forget_worktree("isolated").unwrap();
    store.delete_thread("isolated").unwrap();
    assert!(store.thread("isolated").unwrap().is_none());
}

#[test]
fn provider_identity_and_opaque_session_state_survive_reopen_and_delete() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("harness.db");
    let store = Store::open(&path).unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread_with_connection(
            thread("api-thread", "/repo", ProviderId::Api),
            Some("work-openrouter"),
        )
        .unwrap();
    store
        .set_provider_session_state(
            "api-thread",
            &json!({
                "model": "openai/gpt-test",
                "messages": [{ "role": "user", "content": "hello" }]
            }),
        )
        .unwrap();
    store.close().unwrap();

    let mut reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.thread_connection_id("api-thread").unwrap(),
        Some("work-openrouter".into())
    );
    assert_eq!(
        reopened.provider_session_state("api-thread").unwrap(),
        Some(json!({
            "model": "openai/gpt-test",
            "messages": [{ "role": "user", "content": "hello" }]
        }))
    );
    reopened.delete_thread("api-thread").unwrap();
    assert!(
        reopened
            .provider_session_state("api-thread")
            .unwrap()
            .is_none()
    );
}

#[test]
fn lifecycle_and_sidebar_settings_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("harness.db");
    let store = Store::open(&path).unwrap();
    store.add_project("/repo", None).unwrap();
    let mut stored = thread("t1", "/repo", ProviderId::Codex);
    stored.created_at = Some(10);
    store.add_thread(stored).unwrap();
    store.snooze_thread("t1", 100, Some(20)).unwrap();
    store
        .update_sidebar_settings(SidebarSettingsUpdate {
            mode: Some(SidebarMode::Classic),
            auto_settle_days: Some(None),
        })
        .unwrap();
    store.close().unwrap();

    let reopened = Store::open(&path).unwrap();
    assert_eq!(
        reopened.thread("t1").unwrap().unwrap().lifecycle,
        ThreadLifecycle::Snoozed {
            snoozed_at: 20,
            wake_at: 100
        }
    );
    assert_eq!(
        reopened.sidebar_settings().unwrap(),
        SidebarSettings {
            mode: SidebarMode::Classic,
            auto_settle_days: None
        }
    );
    assert!(reopened.due_snoozed_threads(99).unwrap().is_empty());
    assert_eq!(reopened.due_snoozed_threads(100).unwrap()[0].id, "t1");
}

#[test]
fn lifecycle_updates_preserve_wake_and_unread_semantics() {
    let store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    store
        .settle_thread("t1", SettleReason::Inactivity, Some(20))
        .unwrap();
    let active = store.touch_thread("t1", true, Some(30)).unwrap();
    assert_eq!(
        active,
        ThreadLifecycle::Active {
            keep_active: false,
            woke_at: Some(30)
        }
    );
    assert!(store.thread("t1").unwrap().unwrap().unread);
    store.set_thread_keep_active("t1", true, Some(40)).unwrap();
    assert!(store.inactive_threads(10_000).unwrap().is_empty());
    store.mark_thread_read("t1").unwrap();
    let stored = store.thread("t1").unwrap().unwrap();
    assert!(!stored.unread);
    assert_eq!(
        stored.lifecycle,
        ThreadLifecycle::Active {
            keep_active: true,
            woke_at: None
        }
    );
}

#[test]
fn design_runs_and_diff_decisions_replace_and_delete_cleanly() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    store
        .set_design_run("t1", &json!({ "phase": "brief" }))
        .unwrap();
    store
        .set_design_run("t1", &json!({ "phase": "brand" }))
        .unwrap();
    assert_eq!(
        store.design_run("t1").unwrap(),
        Some(json!({ "phase": "brand" }))
    );
    store
        .set_diff_decision("t1", "hunk:one", DiffDecision::Accept)
        .unwrap();
    store
        .set_diff_decision("t1", "hunk:one", DiffDecision::Reject)
        .unwrap();
    assert_eq!(
        store.diff_decision("t1", "hunk:one").unwrap(),
        Some(DiffDecision::Reject)
    );
    store.delete_thread("t1").unwrap();
    assert!(store.design_run("t1").unwrap().is_none());
    assert!(store.diff_decision("t1", "hunk:one").unwrap().is_none());
}

#[test]
fn opening_an_old_database_adds_new_columns_without_losing_rows() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("old.db");
    let old = Connection::open(&path).unwrap();
    old.execute_batch(
        "CREATE TABLE projects (path TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE threads (
           id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
           agent TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER);
         CREATE TABLE events (
           seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
           at INTEGER NOT NULL, payload TEXT NOT NULL);
         INSERT INTO projects VALUES ('/repo', 'Old project', 1);
         INSERT INTO threads VALUES ('t1', '/repo', 'codex', NULL, 'Old session', 1, NULL);",
    )
    .unwrap();
    old.close().unwrap();

    let migrated = Store::open(&path).unwrap();
    assert_eq!(
        migrated.project("/repo").unwrap().unwrap().name,
        "Old project"
    );
    let thread = migrated.thread("t1").unwrap().unwrap();
    assert_eq!(thread.title, "Old session");
    assert_eq!(migrated.thread_connection_id("t1").unwrap(), None);
    migrated
        .set_provider_session_state("t1", &json!({ "legacy": true }))
        .unwrap();
    assert_eq!(
        migrated.provider_session_state("t1").unwrap(),
        Some(json!({ "legacy": true }))
    );
    assert_eq!(
        thread.lifecycle,
        ThreadLifecycle::Active {
            keep_active: false,
            woke_at: None
        }
    );
    migrated.set_project_pinned("/repo", true).unwrap();
    migrated.set_thread_pinned("t1", true).unwrap();
    assert!(migrated.project("/repo").unwrap().unwrap().pinned);
    assert!(migrated.thread("t1").unwrap().unwrap().pinned);
}

#[test]
fn missing_thread_lifecycle_mutations_fail_loudly() {
    let store = Store::memory().unwrap();
    assert!(matches!(
        store.settle_thread("missing", SettleReason::Manual, Some(1)),
        Err(StoreError::ThreadNotFound)
    ));
    assert!(matches!(
        store.mark_thread_read("missing"),
        Err(StoreError::ThreadNotFound)
    ));
}

#[test]
fn event_history_is_ordered_thread_scoped_and_resumable() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    store
        .add_thread(thread("t2", "/repo", ProviderId::Codex))
        .unwrap();
    let first = store.append("t1", &message("one", "one", 1.0)).unwrap();
    let second = store.append("t1", &message("two", "two", 2.0)).unwrap();
    store
        .append(
            "t1",
            &message(
                "three",
                "quote \" backslash \\ newline \n null-ish \\u0000 emoji 🙂",
                3.0,
            ),
        )
        .unwrap();
    store
        .append("t2", &message("other", "theirs", 4.0))
        .unwrap();

    assert_eq!(first, 1);
    assert_eq!(store.last_seq("t1").unwrap(), 3);
    assert_eq!(store.history("t1", 0).unwrap().len(), 3);
    let tail = store.history("t1", second).unwrap();
    assert_eq!(tail.len(), 1);
    let DomainEvent::ItemCompleted { item } = &tail[0].event else {
        panic!("expected a completed item");
    };
    assert!(item.text.as_deref().unwrap().contains("emoji 🙂"));
    assert_eq!(store.history("t2", 0).unwrap().len(), 1);
    assert_eq!(store.last_seq("missing").unwrap(), 0);
}

#[test]
fn search_indexes_useful_output_filters_and_plain_text_highlights() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", Some("Harness")).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    store
        .append(
            "t1",
            &message("message", "<img src=x onerror=alert(1)> regression", 1.0),
        )
        .unwrap();
    let mut command = match message("command", "regression suite passed", 2.0) {
        DomainEvent::ItemCompleted { item } => item,
        _ => unreachable!(),
    };
    command.item_type = ItemType::Command;
    command.command = Some("pnpm test".into());
    store
        .append("t1", &DomainEvent::ItemCompleted { item: command })
        .unwrap();
    let mut reasoning = match message("reasoning", "private-thought-marker", 3.0) {
        DomainEvent::ItemCompleted { item } => item,
        _ => unreachable!(),
    };
    reasoning.item_type = ItemType::Reasoning;
    store
        .append("t1", &DomainEvent::ItemCompleted { item: reasoning })
        .unwrap();

    let regression = store
        .search_sessions(&SearchOptions {
            query: "regression".into(),
            ..SearchOptions::default()
        })
        .unwrap();
    assert_eq!(regression.results.len(), 2);
    assert!(regression.results.iter().any(|result| {
        result
            .snippet
            .iter()
            .any(|part| part.text == "regression" && part.highlighted)
    }));
    let plain = regression.results[0]
        .snippet
        .iter()
        .map(|part| part.text.as_str())
        .collect::<String>();
    assert!(!plain.contains("<mark>"));
    assert_eq!(
        store
            .search_sessions(&SearchOptions {
                query: "pnpm".into(),
                ..SearchOptions::default()
            })
            .unwrap()
            .results[0]
            .turn_id,
        "command"
    );
    assert!(
        store
            .search_sessions(&SearchOptions {
                query: "private-thought-marker".into(),
                ..SearchOptions::default()
            })
            .unwrap()
            .results
            .is_empty()
    );
}

#[test]
fn search_filters_and_cursor_pagination_do_not_repeat_results() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", Some("Harness")).unwrap();
    store.add_project("/other", Some("Other")).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    store
        .add_thread(thread("t2", "/other", ProviderId::ClaudeCode))
        .unwrap();
    store
        .append("t1", &message("one", "shared stable marker", 1.0))
        .unwrap();
    store
        .append("t2", &message("two", "shared stable marker", 2.0))
        .unwrap();

    assert_eq!(
        store
            .search_sessions(&SearchOptions {
                query: "shared".into(),
                provider: Some(ProviderId::Codex),
                ..SearchOptions::default()
            })
            .unwrap()
            .results[0]
            .thread_id,
        "t1"
    );
    assert_eq!(
        store
            .search_sessions(&SearchOptions {
                query: "shared".into(),
                project_path: Some("/other".into()),
                ..SearchOptions::default()
            })
            .unwrap()
            .results[0]
            .thread_id,
        "t2"
    );

    let first = store
        .search_sessions(&SearchOptions {
            query: "shared".into(),
            limit: Some(1),
            ..SearchOptions::default()
        })
        .unwrap();
    store
        .append("t1", &message("new", "shared stable marker", 3.0))
        .unwrap();
    let second = store
        .search_sessions(&SearchOptions {
            query: "shared".into(),
            limit: Some(1),
            cursor: first.next_cursor.clone(),
            ..SearchOptions::default()
        })
        .unwrap();
    assert_ne!(first.results[0].turn_id, second.results[0].turn_id);
}

#[test]
fn search_clamps_limits_and_treats_bad_cursors_as_fresh() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    for index in 0..101 {
        store
            .append(
                "t1",
                &message(
                    &format!("turn-{index}"),
                    &format!("bounded result {index}"),
                    index as f64,
                ),
            )
            .unwrap();
    }
    assert_eq!(
        store
            .search_sessions(&SearchOptions {
                query: "bounded".into(),
                limit: Some(1_000),
                ..SearchOptions::default()
            })
            .unwrap()
            .results
            .len(),
        100
    );
    let fresh = store
        .search_sessions(&SearchOptions {
            query: "bounded".into(),
            limit: Some(1),
            ..SearchOptions::default()
        })
        .unwrap();
    let malformed = store
        .search_sessions(&SearchOptions {
            query: "bounded".into(),
            limit: Some(1),
            cursor: Some("not-json".into()),
            ..SearchOptions::default()
        })
        .unwrap();
    assert_eq!(malformed, fresh);
    assert!(matches!(
        store.search_sessions(&SearchOptions::default()),
        Err(StoreError::EmptySearchQuery)
    ));
}

#[test]
fn append_rolls_back_when_atomic_search_indexing_fails() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("atomic.db");
    let seeded = Store::open(&path).unwrap();
    seeded.add_project("/repo", None).unwrap();
    seeded
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    seeded
        .set_provider_session_state("t1", &json!({ "version": "before" }))
        .unwrap();
    seeded.close().unwrap();
    let raw = Connection::open(&path).unwrap();
    raw.execute(
        "INSERT INTO session_search
         (rowid, thread_id, event_seq, turn_id, created_at, text)
         VALUES (1, 't1', 1, 't1', 1, 'collision')",
        [],
    )
    .unwrap();
    raw.close().unwrap();

    let mut reopened = Store::open(&path).unwrap();
    assert!(
        reopened
            .append_with_provider_state(
                "t1",
                &message("t1", "atomic result", 1.0),
                Some(&json!({ "version": "after" })),
            )
            .is_err()
    );
    assert!(reopened.history("t1", 0).unwrap().is_empty());
    assert_eq!(
        reopened.provider_session_state("t1").unwrap(),
        Some(json!({ "version": "before" }))
    );
}

#[test]
fn incomplete_search_migrations_are_rebuilt_from_the_event_log() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("partial.db");
    let partial = Connection::open(&path).unwrap();
    partial
        .execute_batch(
            "CREATE TABLE projects (
               path TEXT PRIMARY KEY, name TEXT NOT NULL, pinned INTEGER NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE threads (
               id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
               agent TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL, closed_at INTEGER,
               worktree_path TEXT, worktree_branch TEXT);
             CREATE TABLE events (
               seq INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL,
               at INTEGER NOT NULL, payload TEXT NOT NULL);
             CREATE VIRTUAL TABLE session_search USING fts5 (
               thread_id UNINDEXED, event_seq UNINDEXED, turn_id UNINDEXED,
               created_at UNINDEXED, text);
             INSERT INTO projects VALUES ('/repo', 'Repo', 0, 1);
             INSERT INTO threads VALUES ('t1', '/repo', 'codex', NULL, 'Thread', 1, NULL, NULL, NULL);",
        )
        .unwrap();
    partial
        .execute(
            "INSERT INTO events (thread_id, at, payload) VALUES (?1, 1, ?2)",
            params![
                "t1",
                serde_json::to_string(&message("t1", "migration result", 1.0)).unwrap()
            ],
        )
        .unwrap();
    partial
        .execute(
            "INSERT INTO session_search
             (rowid, thread_id, event_seq, turn_id, created_at, text)
             VALUES (99, 't1', 99, 'bad', 1, 'partial row')",
            [],
        )
        .unwrap();
    partial.close().unwrap();

    let migrated = Store::open(&path).unwrap();
    let result = migrated
        .search_sessions(&SearchOptions {
            query: "migration".into(),
            ..SearchOptions::default()
        })
        .unwrap();
    assert_eq!(result.results.len(), 1);
    assert_eq!(result.results[0].turn_id, "t1");
    assert!(
        migrated
            .search_sessions(&SearchOptions {
                query: "partial".into(),
                ..SearchOptions::default()
            })
            .unwrap()
            .results
            .is_empty()
    );
}

#[test]
fn usage_totals_handle_cumulative_per_turn_and_cross_provider_events() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("codex", "/repo", ProviderId::Codex))
        .unwrap();
    store
        .add_thread(thread("claude", "/repo", ProviderId::ClaudeCode))
        .unwrap();
    store.append_at("codex", &usage(100.0, None), 100).unwrap();
    store.append_at("codex", &usage(140.0, None), 200).unwrap();
    store
        .append_at("claude", &usage(20.0, Some(0.03)), 200)
        .unwrap();
    store
        .append_at("claude", &usage(30.0, Some(0.04)), 300)
        .unwrap();

    let codex = store.usage_summary("codex", 150).unwrap();
    assert_eq!(codex.session.total_tokens, 140.0);
    assert_eq!(codex.today.total_tokens, 90.0);
    assert_eq!(codex.today.cost_usd, Some(0.07));
    let claude = store.usage_summary("claude", 0).unwrap();
    assert_eq!(claude.session.total_tokens, 50.0);
    assert_eq!(claude.session.cost_usd, Some(0.07));
    assert_eq!(claude.today.total_tokens, 190.0);
}

#[test]
fn checkpoints_and_restore_undo_keep_filesystem_and_history_positions_aligned() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    let keep_seq = store
        .append("t1", &message("keep", "keep this result", 1.0))
        .unwrap();
    let keep = store
        .add_checkpoint_at(
            NewCheckpoint {
                thread_id: "t1".into(),
                seq: keep_seq,
                commit: "commit-keep".into(),
                label: "Keep".into(),
            },
            10,
        )
        .unwrap();
    let temporary_seq = store
        .append("t1", &message("temporary", "temporary marker", 2.0))
        .unwrap();
    let temporary = store
        .add_checkpoint_at(
            NewCheckpoint {
                thread_id: "t1".into(),
                seq: temporary_seq,
                commit: "commit-temporary".into(),
                label: "Temporary".into(),
            },
            20,
        )
        .unwrap();

    assert_eq!(store.checkpoint(keep.id).unwrap(), Some(keep.clone()));
    assert_eq!(
        store.checkpoints("t1").unwrap(),
        [keep.clone(), temporary.clone()]
    );
    let token = store
        .save_restore_undo("t1", keep_seq, "snapshot-before-restore")
        .unwrap();
    assert_eq!(store.history("t1", 0).unwrap().len(), 1);
    assert_eq!(store.checkpoints("t1").unwrap(), [keep,]);
    assert!(
        store
            .search_sessions(&SearchOptions {
                query: "temporary".into(),
                ..SearchOptions::default()
            })
            .unwrap()
            .results
            .is_empty()
    );
    assert_eq!(
        store.restore_undo("t1", &token).unwrap(),
        Some(RestoreUndo {
            commit: "snapshot-before-restore".into()
        })
    );

    store.apply_restore_undo("t1", &token).unwrap();
    assert_eq!(store.history("t1", 0).unwrap().len(), 2);
    assert_eq!(store.checkpoints("t1").unwrap()[1], temporary);
    assert_eq!(
        store
            .search_sessions(&SearchOptions {
                query: "temporary".into(),
                ..SearchOptions::default()
            })
            .unwrap()
            .results
            .len(),
        1
    );
    assert!(store.restore_undo("t1", &token).unwrap().is_none());
}

#[test]
fn restore_undo_refuses_to_overwrite_conversation_that_continued() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    let keep_seq = store.append("t1", &message("keep", "keep", 1.0)).unwrap();
    store
        .append("t1", &message("removed", "removed", 2.0))
        .unwrap();
    let token = store.save_restore_undo("t1", keep_seq, "snapshot").unwrap();
    store
        .append("t1", &message("continued", "continued", 3.0))
        .unwrap();

    assert!(matches!(
        store.apply_restore_undo("t1", &token),
        Err(StoreError::RestoreContinued)
    ));
    assert!(matches!(
        store.apply_restore_undo("t1", "missing"),
        Err(StoreError::RestoreUnavailable)
    ));
}

#[test]
fn a_new_restore_replaces_the_previous_undo_token_for_that_thread() {
    let mut store = Store::memory().unwrap();
    store.add_project("/repo", None).unwrap();
    store
        .add_thread(thread("t1", "/repo", ProviderId::Codex))
        .unwrap();
    let keep_seq = store.append("t1", &message("keep", "keep", 1.0)).unwrap();
    store
        .append("t1", &message("first-tail", "first tail", 2.0))
        .unwrap();
    let first = store
        .save_restore_undo("t1", keep_seq, "first-snapshot")
        .unwrap();
    store
        .append("t1", &message("second-tail", "second tail", 3.0))
        .unwrap();
    let second = store
        .save_restore_undo("t1", keep_seq, "second-snapshot")
        .unwrap();

    assert!(store.restore_undo("t1", &first).unwrap().is_none());
    assert_eq!(
        store.restore_undo("t1", &second).unwrap(),
        Some(RestoreUndo {
            commit: "second-snapshot".into()
        })
    );
}
