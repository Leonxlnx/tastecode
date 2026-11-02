import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { finished } from 'node:stream/promises'
import { findClaudeSessionFile } from './history.js'

/** Claude Code 2.1.306 shortens a longer folder name with a hash of its own. */
const PROJECT_FOLDER_LENGTH = 200

/**
 * The folder under `projects` where Claude Code saves the sessions of a
 * working directory: its real path, every character but a letter or digit
 * made "-". Undefined for a name long enough to be shortened.
 */
export function claudeProjectFolder(cwd: string): string | undefined {
  let real = path.resolve(cwd)
  try {
    real = realpathSync(real)
  } catch {
    // Claude Code names a folder that is gone by the path it was given.
  }
  if (process.platform === 'darwin') real = real.normalize('NFC')
  const name = real.replace(/[^a-zA-Z0-9]/g, '-')
  return name.length <= PROJECT_FOLDER_LENGTH ? name : undefined
}

/**
 * Writes a saved session into a config folder as a new session for `to.cwd`,
 * as `claude --resume <id> --fork-session --session-id <new>` does: the same
 * records, each naming the new session. Claude Code 2.1.306 writes its fork
 * only with the first prompt, so a session forked that way and stopped before
 * then resumes empty; this copy exists at once. `from` and `to.configDir` may
 * be the same folder, or two accounts' folders.
 *
 * Resolves the copy's path, or undefined when `from` holds no transcript of
 * the session.
 */
export async function copyClaudeSession(
  sessionId: string,
  from: string,
  to: { configDir: string; sessionId: string; cwd: string },
): Promise<string | undefined> {
  const source = await findClaudeSessionFile(sessionId, { configDir: from })
  if (!source) return undefined
  const project = claudeProjectFolder(to.cwd)
  if (project === undefined) throw new Error('The working folder path is too long to carry on.')
  const folder = path.join(path.resolve(to.configDir), 'projects', project)
  const target = path.join(folder, `${to.sessionId}.jsonl`)
  // Written beside its final name, so a reader never meets half a transcript.
  const partial = path.join(folder, `.${to.sessionId}.${randomUUID()}.partial`)
  await mkdir(folder, { recursive: true })
  const input = createReadStream(source, { encoding: 'utf8' })
  const output = createWriteStream(partial, { encoding: 'utf8', flags: 'wx', mode: 0o600 })
  const named = `"sessionId":"${sessionId}"`
  const renamed = (line: string): string => {
    if (!line.includes(named)) return line
    try {
      const record: unknown = JSON.parse(line)
      if (
        record !== null &&
        typeof record === 'object' &&
        'sessionId' in record &&
        record.sessionId === sessionId
      )
        return JSON.stringify({ ...record, sessionId: to.sessionId })
    } catch {
      // A record cut short by a concurrent write is copied as it is; Claude Code skips it.
    }
    return line
  }
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!output.write(`${renamed(line)}\n`)) await once(output, 'drain')
    }
    output.end()
    await finished(output)
    await rename(partial, target)
  } catch (error) {
    input.destroy()
    output.destroy()
    await rm(partial, { force: true })
    throw error
  }
  return target
}
