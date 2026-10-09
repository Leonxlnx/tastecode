import path from 'node:path'
import { existsSync } from 'node:fs'
import { Store } from './store.js'
import { storeLocation } from './data-location.js'
import { checkpointRepository, clearSnapshotRefs, syncCheckpointRefs } from './checkpoint.js'
import { acquireDataLease } from './data-lease.js'

export const HISTORY_HELP = `History commands:
  harness history stats
  harness history export --output <new-file.ndjson>
  harness history prune --before <YYYY-MM-DD>
  harness history prune --before <YYYY-MM-DD> --archive <new-file.ndjson> --apply
  harness history compact

Prune previews eligible closed tasks by default. Applying it first saves their
history to a new archive. Active tasks and tasks with private checkouts stay.
Close TasteCode and its core server before using history commands.
Archives contain conversation records, not a backup of workspace files.
Compact removes streamed text fragments that completed messages already contain,
then reclaims free database pages. HARNESS_DATA_DIR selects the data folder.
`

export async function runHistoryCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  output: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
  if (args.length === 0 || args.includes('--help')) {
    output(HISTORY_HELP)
    return
  }
  const [command, ...rest] = args
  const flags = new Map<string, string | true>()
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]!
    if (!['--before', '--output', '--archive', '--apply'].includes(flag) || flags.has(flag))
      throw new Error(`Unknown or repeated history option: ${flag}`)
    if (flag === '--apply') flags.set(flag, true)
    else {
      const value = rest[++index]
      if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      flags.set(flag, value)
    }
  }
  const permitted =
    command === 'prune'
      ? ['--before', '--archive', '--apply']
      : command === 'export'
        ? ['--output']
        : []
  if ([...flags.keys()].some((flag) => !permitted.includes(flag)))
    throw new Error('Option does not apply to this history command')
  if (!['stats', 'export', 'prune', 'compact'].includes(command!))
    throw new Error('Unknown history command')
  const location = storeLocation(env)
  if (!existsSync(location)) throw new Error('No history database exists in this data folder')
  const releaseLease = acquireDataLease(location)
  let store: Store
  try {
    store = new Store(location)
  } catch (error) {
    releaseLease()
    throw error
  }
  try {
    if (command === 'stats') {
      output(JSON.stringify(store.historyStorage(), null, 2))
      return
    }
    if (command === 'export') {
      const destination = flags.get('--output')
      if (typeof destination !== 'string')
        throw new Error('Export requires --output <new-file.ndjson>')
      store.exportHistory(path.resolve(destination))
      output(`History saved to ${path.resolve(destination)}`)
      return
    }
    if (command === 'compact') {
      const foldedDeltaEvents = store.foldCompletedItemDeltas()
      store.reclaimHistorySpace()
      output(JSON.stringify({ foldedDeltaEvents, ...store.historyStorage() }, null, 2))
      return
    }
    const date = flags.get('--before')
    const before =
      typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? Date.parse(`${date}T00:00:00.000Z`)
        : NaN
    if (!Number.isFinite(before) || new Date(before).toISOString().slice(0, 10) !== date)
      throw new Error('Prune requires a valid --before YYYY-MM-DD date')
    const candidates = store.historyCleanupCandidates(before)
    if (!flags.has('--apply')) {
      output(
        JSON.stringify(
          { dryRun: true, closedTasks: candidates.length, threadIds: candidates },
          null,
          2,
        ),
      )
      return
    }
    const archive = flags.get('--archive')
    if (typeof archive !== 'string')
      throw new Error('Prune --apply requires --archive <new-file.ndjson>')
    const priorRefs = store.checkpointReferences()
    // A recorded directory can stop being a Git repository; that must not block every prune.
    const roots = new Map<string, string | undefined>()
    const rootFor = async (directory: string) => {
      if (!roots.has(directory))
        roots.set(directory, await checkpointRepository(directory).catch(() => undefined))
      return roots.get(directory)
    }
    const entryPath = (entry: (typeof priorRefs)[number]) =>
      entry.worktreePath && existsSync(entry.worktreePath) ? entry.worktreePath : entry.projectPath
    const commitsByRepo = new Map<string, Set<string>>()
    // Resolve groups before deleting anything. One shared ref namespace is
    // synchronized once, with the union of every retained worktree's commits.
    for (const directory of [...store.checkpointRepositories(), ...priorRefs.map(entryPath)]) {
      const root = existsSync(directory) ? await rootFor(directory) : undefined
      if (root) commitsByRepo.set(root, new Set())
    }
    const count = store.pruneHistory(before, path.resolve(archive))
    const unlocated: string[] = []
    for (const entry of store.checkpointReferences()) {
      const directory = entryPath(entry)
      if (!existsSync(directory)) continue
      const repo = await rootFor(directory)
      if (!repo) {
        unlocated.push(directory)
        continue
      }
      const commits = commitsByRepo.get(repo) ?? new Set<string>()
      for (const commit of entry.commits) commits.add(commit)
      commitsByRepo.set(repo, commits)
    }
    const cleanupErrors: unknown[] = []
    // A retained checkout that cannot be located may share a repository's refs; syncing
    // without its commits would delete checkpoints that task still needs.
    if (unlocated.length) {
      cleanupErrors.push(
        new Error(`Could not locate Git checkpoint storage for ${unlocated.join(', ')}`),
      )
      commitsByRepo.clear()
    }
    for (const [repo, commits] of commitsByRepo) {
      if (!existsSync(repo)) continue
      try {
        await syncCheckpointRefs(repo, store.checkpointNamespace, commits)
        await clearSnapshotRefs(repo)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    store.reclaimHistorySpace()
    output(`Removed ${count} closed tasks. History archive: ${path.resolve(archive)}`)
    if (cleanupErrors.length)
      throw new AggregateError(
        cleanupErrors,
        'History was archived and cleaned, but some Git checkpoint refs could not be removed',
      )
  } finally {
    try {
      store.close()
    } finally {
      releaseLease()
    }
  }
}
