import { DatabaseSync } from 'node:sqlite'
import { afterAll, bench, describe } from 'vitest'
import { createSearchSnippet } from './store.js'

const OPTIONS = { iterations: 10, time: 0, warmupIterations: 3, warmupTime: 0 }
const MATCH = 'performance*'
const START = '\u0001'
const END = '\u0002'
const database = new DatabaseSync(':memory:')

database.exec(`
  CREATE VIRTUAL TABLE session_search USING fts5 (
    thread_id UNINDEXED,
    event_seq UNINDEXED,
    turn_id UNINDEXED,
    created_at UNINDEXED,
    text,
    tokenize = 'unicode61'
  );
  CREATE TABLE projects (
    path TEXT PRIMARY KEY
  );
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    provider TEXT NOT NULL
  );
  CREATE TEMP TABLE eager_snapshot (
    position INTEGER PRIMARY KEY,
    search_rowid INTEGER NOT NULL,
    snippet TEXT NOT NULL
  );
  CREATE TEMP TABLE rowid_snapshot (
    position INTEGER PRIMARY KEY,
    search_rowid INTEGER NOT NULL
  );
  CREATE TEMP TABLE unique_production_snapshot (
    position INTEGER PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    search_rowid INTEGER NOT NULL,
    UNIQUE (snapshot_id, search_rowid)
  );
  CREATE INDEX unique_production_snapshot_page
    ON unique_production_snapshot (snapshot_id, position);
  CREATE TEMP TABLE lean_production_snapshot (
    position INTEGER PRIMARY KEY,
    snapshot_id TEXT NOT NULL,
    search_rowid INTEGER NOT NULL
  );
  CREATE INDEX lean_production_snapshot_page
    ON lean_production_snapshot (snapshot_id, position);
  CREATE TEMP TABLE json_production_snapshot (
    snapshot_id TEXT PRIMARY KEY,
    search_rowids TEXT NOT NULL
  );
`)

const insertSearch = database.prepare(
  `INSERT INTO session_search (thread_id, event_seq, turn_id, created_at, text)
   VALUES (?, ?, ?, ?, ?)`,
)
database.exec('BEGIN')
const insertProject = database.prepare(`INSERT INTO projects (path) VALUES (?)`)
const insertThread = database.prepare(
  `INSERT INTO threads (id, project_path, provider) VALUES (?, ?, ?)`,
)
for (let project = 0; project < 10; project += 1) insertProject.run(`/project-${project}`)
for (let thread = 0; thread < 1_000; thread += 1) {
  insertThread.run(`thread-${thread}`, `/project-${thread % 10}`, thread % 2 ? 'codex' : 'grok')
}
for (let index = 0; index < 20_000; index += 1) {
  insertSearch.run(
    `thread-${index % 1_000}`,
    index + 1,
    `turn-${index}`,
    index,
    `Performance result ${index}: long thread output and command details for global search.`,
  )
}
database.exec('COMMIT')

const eagerSnapshot = database.prepare(
  `INSERT INTO eager_snapshot (search_rowid, snippet)
   SELECT session_search.rowid, snippet(session_search, 4, ?, ?, ' … ', 24)
   FROM session_search
   WHERE session_search MATCH ?
   ORDER BY bm25(session_search), CAST(session_search.created_at AS INTEGER) DESC,
            session_search.rowid DESC`,
)
const rowidSnapshot = database.prepare(
  `INSERT INTO rowid_snapshot (search_rowid)
   SELECT session_search.rowid
   FROM session_search
   WHERE session_search MATCH ?
   ORDER BY bm25(session_search), CAST(session_search.created_at AS INTEGER) DESC,
            session_search.rowid DESC`,
)
const rankedRowidSnapshot = database.prepare(
  `INSERT INTO rowid_snapshot (search_rowid)
   SELECT session_search.rowid
   FROM session_search
   WHERE session_search MATCH ?
   ORDER BY rank, CAST(session_search.created_at AS INTEGER) DESC,
            session_search.rowid DESC`,
)
const fullyJoinedRankedRowidSnapshot = database.prepare(
  `INSERT INTO rowid_snapshot (search_rowid)
   SELECT session_search.rowid
   FROM session_search
   JOIN threads ON threads.id = session_search.thread_id
   JOIN projects ON projects.path = threads.project_path
   WHERE session_search MATCH ?
   ORDER BY rank, CAST(session_search.created_at AS INTEGER) DESC,
            session_search.rowid DESC`,
)
const threadJoinedRankedRowidSnapshot = database.prepare(
  `INSERT INTO rowid_snapshot (search_rowid)
   SELECT session_search.rowid
   FROM session_search
   JOIN threads ON threads.id = session_search.thread_id
   WHERE session_search MATCH ?
   ORDER BY rank, CAST(session_search.created_at AS INTEGER) DESC,
    session_search.rowid DESC`,
)
const uniqueProductionSnapshot = database.prepare(
  `INSERT INTO unique_production_snapshot (snapshot_id, search_rowid)
   SELECT ?, session_search.rowid
   FROM session_search
   WHERE session_search MATCH ?
   ORDER BY rank, session_search.created_at DESC, session_search.rowid DESC`,
)
const leanProductionSnapshot = database.prepare(
  `INSERT INTO lean_production_snapshot (snapshot_id, search_rowid)
   SELECT ?, session_search.rowid
   FROM session_search
   WHERE session_search MATCH ?
   ORDER BY rank, session_search.created_at DESC, session_search.rowid DESC`,
)
const jsonProductionSnapshot = database.prepare(
  `INSERT INTO json_production_snapshot (snapshot_id, search_rowids)
   SELECT ?, json_group_array(rowid)
   FROM (
     SELECT session_search.rowid AS rowid
     FROM session_search
     WHERE session_search MATCH ?
     ORDER BY rank, session_search.created_at DESC, session_search.rowid DESC
   )`,
)
const selectJsonSnapshot = database.prepare(
  `SELECT json_group_array(rowid) AS search_rowids
   FROM (
     SELECT session_search.rowid AS rowid
     FROM session_search
     WHERE session_search MATCH ?
     ORDER BY rank, session_search.created_at DESC, session_search.rowid DESC
   )`,
)
const eagerPage = database.prepare(`SELECT snippet FROM eager_snapshot ORDER BY position LIMIT 26`)
const rawPageAfterJoin = database.prepare(
  `SELECT rowid_snapshot.position, session_search.text
   FROM rowid_snapshot
   JOIN session_search ON session_search.rowid = rowid_snapshot.search_rowid
   ORDER BY rowid_snapshot.position
   LIMIT 26`,
)
const uniqueProductionPage = database.prepare(
  `SELECT search_rowid FROM unique_production_snapshot
   WHERE snapshot_id = ? ORDER BY position LIMIT 26`,
)
const leanProductionPage = database.prepare(
  `SELECT search_rowid FROM lean_production_snapshot
   WHERE snapshot_id = ? ORDER BY position LIMIT 26`,
)
const jsonProductionPage = database.prepare(
  `SELECT CAST(page.value AS INTEGER) AS search_rowid
   FROM json_production_snapshot AS snapshot,
        json_each(snapshot.search_rowids) AS page
   WHERE snapshot.snapshot_id = ? AND CAST(page.key AS INTEGER) >= ?
   ORDER BY CAST(page.key AS INTEGER)
   LIMIT 26`,
)
const parameterizedJsonPage = database.prepare(
  `SELECT session_search.text
   FROM json_each(?) AS page
   JOIN session_search ON session_search.rowid = CAST(page.value AS INTEGER)
   ORDER BY CAST(page.key AS INTEGER)`,
)

function eager(): void {
  database.exec('DELETE FROM eager_snapshot')
  eagerSnapshot.run(START, END, MATCH)
  if (eagerPage.all().length !== 26) throw new Error('invalid eager page')
}

function pageRawTextAfterJoin(): void {
  database.exec('DELETE FROM rowid_snapshot')
  rowidSnapshot.run(MATCH)
  const rows = rawPageAfterJoin.all()
  if (rows.length !== 26) throw new Error('invalid raw joined page')
  for (const row of rows) createSearchSnippet(String(row['text']), ['performance'])
}

function pageRawTextAfterRankJoin(): void {
  database.exec('DELETE FROM rowid_snapshot')
  rankedRowidSnapshot.run(MATCH)
  const rows = rawPageAfterJoin.all()
  if (rows.length !== 26) throw new Error('invalid ranked raw joined page')
  for (const row of rows) createSearchSnippet(String(row['text']), ['performance'])
}

function pageAfterFullyJoinedRank(): void {
  database.exec('DELETE FROM rowid_snapshot')
  fullyJoinedRankedRowidSnapshot.run(MATCH)
  const rows = rawPageAfterJoin.all()
  if (rows.length !== 26) throw new Error('invalid fully joined ranked page')
  for (const row of rows) createSearchSnippet(String(row['text']), ['performance'])
}

function pageAfterThreadJoinedRank(): void {
  database.exec('DELETE FROM rowid_snapshot')
  threadJoinedRankedRowidSnapshot.run(MATCH)
  const rows = rawPageAfterJoin.all()
  if (rows.length !== 26) throw new Error('invalid thread joined ranked page')
  for (const row of rows) createSearchSnippet(String(row['text']), ['performance'])
}

function snapshotWithUniqueIndex(): void {
  database.exec('DELETE FROM unique_production_snapshot')
  uniqueProductionSnapshot.run('snapshot', MATCH)
  if (uniqueProductionPage.all('snapshot').length !== 26) throw new Error('invalid unique page')
}

function snapshotWithoutUniqueIndex(): void {
  database.exec('DELETE FROM lean_production_snapshot')
  leanProductionSnapshot.run('snapshot', MATCH)
  if (leanProductionPage.all('snapshot').length !== 26) throw new Error('invalid lean page')
}

function snapshotAsJson(): void {
  database.exec('DELETE FROM json_production_snapshot')
  jsonProductionSnapshot.run('snapshot', MATCH)
  if (jsonProductionPage.all('snapshot', 0).length !== 26) throw new Error('invalid JSON page')
}

function readDeepJsonPage(): void {
  if (jsonProductionPage.all('snapshot', 10_000).length !== 26) {
    throw new Error('invalid deep JSON page')
  }
}

function snapshotInMemory(): void {
  const row = selectJsonSnapshot.get(MATCH)
  const rowIds = JSON.parse(String(row?.['search_rowids'])) as number[]
  const rows = parameterizedJsonPage.all(JSON.stringify(rowIds.slice(0, 26)))
  if (rows.length !== 26) throw new Error('invalid in-memory page')
  for (const result of rows) createSearchSnippet(String(result['text']), ['performance'])
}

afterAll(() => database.close())

describe('broad global search first page', () => {
  bench('stores snippets for all 20,000 ranked matches', eager, OPTIONS)
  bench('stores row IDs and formats only 26 visible matches', pageRawTextAfterJoin, OPTIONS)
  bench('uses the cached FTS rank while storing row IDs', pageRawTextAfterRankJoin, OPTIONS)
  bench('joins projects while storing globally ranked row IDs', pageAfterFullyJoinedRank, OPTIONS)
  bench(
    'skips the redundant project join while storing ranked row IDs',
    pageAfterThreadJoinedRank,
    OPTIONS,
  )
})

describe('production search snapshot indexing', () => {
  bench('writes a redundant unique index for all 20,000 matches', snapshotWithUniqueIndex, OPTIONS)
  bench('writes only the page index for all 20,000 matches', snapshotWithoutUniqueIndex, OPTIONS)
  bench('stores all 20,000 ranked row IDs in one JSON snapshot', snapshotAsJson, OPTIONS)
  bench('keeps ranked row IDs in memory and joins only the visible page', snapshotInMemory, OPTIONS)
  bench('reads a deep page from the JSON snapshot', readDeepJsonPage, OPTIONS)
})
