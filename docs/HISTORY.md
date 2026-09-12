# History maintenance

History stays until you remove it. The app does not delete old conversations on a timer.
Close TasteCode and its core server before these commands. An OS-backed database lock
prevents the app and the maintenance tool from opening the same data folder at once.

Build the server from the repository root first:

```text
pnpm --filter @harness/server build
```

Show database size, WAL size, free pages, and task/event counts:

```text
node apps/server/dist/cli.js history stats
```

Export all conversation records to a new file:

```text
node apps/server/dist/cli.js history export --output history.ndjson
```

Preview which closed tasks are older than a date. The date is midnight UTC. This command
does not remove tasks:

```text
node apps/server/dist/cli.js history prune --before 2026-01-01
```

Apply cleanup only after reviewing that list:

```text
node apps/server/dist/cli.js history prune --before 2026-01-01 --archive old-history.ndjson --apply
```

The tool writes and flushes the archive before it deletes any rows. It refuses to overwrite
an existing archive. Active tasks and tasks with a private checkout remain. A failed archive
write leaves the conversations in the database. The archive contains thread, event,
checkpoint, restore, diff-decision, and design-run records in versioned NDJSON. It is an
export for inspection or future import; there is no automatic import command.

**The archive is not a backup of workspace files.** Save wanted file states as normal Git
commits before removing their task history. Checkpoint refs for retained tasks remain,
including undo states and checkpoints hidden by a restore. Cleanup groups worktrees by
their common Git object directory, removes only this database's unused durable refs, and
clears disposable diff-cache refs. It does not run Git garbage collection or delete worktrees.

Prune also reclaims unused database pages. To reclaim pages without deleting conversations:

```text
node apps/server/dist/cli.js history compact
```

`HARNESS_DATA_DIR` selects a different data folder. Default locations are listed in
[Architecture](./ARCHITECTURE.md). The `tastecode.db.owner.sqlite` file is a stable lock
file, not a second history database. Leave it in place; a process exit releases its lock.
