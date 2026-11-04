import { createReadStream } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

type JsonObject = Record<string, unknown>

/** A rollout in the store's own session folders; any other path is never opened. */
export async function allowedFile(home: string, file: string): Promise<boolean> {
  try {
    const canonical = await realpath(file)
    // Listing follows a linked sessions folder, so its target is the boundary.
    const folders = await Promise.all(
      ['sessions', 'archived_sessions'].map((name) =>
        realpath(path.join(home, name)).catch(() => undefined),
      ),
    )
    const inside = folders.some((folder) => {
      if (!folder) return false
      const relative = path.relative(folder, canonical)
      return (
        relative !== '' && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..')
      )
    })
    return inside && path.extname(file) === '.jsonl' && (await stat(file)).isFile()
  } catch {
    return false
  }
}

/** Codex's state databases, newest schema first. */
export async function stateFiles(home: string): Promise<string[]> {
  try {
    const files = (await readdir(home)).filter((file) => /^state_\d+\.sqlite$/.test(file))
    return files.sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))
  } catch {
    return []
  }
}

export async function* jsonLines(file: string): AsyncGenerator<JsonObject> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      try {
        const value: unknown = JSON.parse(line)
        if (value !== null && typeof value === 'object' && !Array.isArray(value))
          yield value as JsonObject
      } catch {
        /* Partial trailing writes and malformed rows cannot hide the rest. */
      }
    }
  } catch {
    /* Missing and concurrently removed history files are normal. */
  } finally {
    lines.close()
    input.destroy()
  }
}
