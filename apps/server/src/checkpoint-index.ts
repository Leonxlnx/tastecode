import { spawnCli } from '@harness/proc/cli'
import { killTree } from '@harness/proc/kill'

// ls-files -v -z prefixes each nonempty record with its flag and a space.
// Keep just the prefix position across pipe chunks, including a split "H ".
export class IndexFlags {
  #prefix = 0
  #valid = true

  push(chunk: string): void {
    for (let i = 0; this.#valid && i < chunk.length; i++) {
      if (this.#prefix === 2) {
        const end = chunk.indexOf('\0', i)
        if (end === -1) return
        this.#prefix = 0
        i = end
      } else if (this.#prefix === 1) {
        this.#valid = chunk[i] === ' '
        this.#prefix = 2
      } else if (chunk[i] !== '\0') {
        this.#valid = chunk[i] === 'H'
        this.#prefix = 1
      }
    }
  }

  trusted(): boolean {
    return this.#valid && this.#prefix !== 1
  }
}

/** Status can hide edits to assume-unchanged and skip-worktree entries. */
export async function indexTrustsWorkingTree(cwd: string, timeout = 20_000): Promise<boolean> {
  try {
    const child = spawnCli('git', ['ls-files', '-v', '-z'], {
      cwd,
      replaceEnv: true,
      env: process.env,
    })
    return await new Promise<boolean>((resolve) => {
      const flags = new IndexFlags()
      let stdoutBytes = 0
      let stderrBytes = 0
      let failed = false
      const fail = () => {
        if (failed) return
        failed = true
        void killTree(child).then(
          () => resolve(false),
          () => resolve(false),
        )
      }
      // Match the former execFile limits independently on both pipes.
      const limit = 256 * 1024 * 1024
      const timer = setTimeout(fail, timeout)
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk)
        if (stdoutBytes > limit) fail()
        else flags.push(chunk)
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderrBytes += Buffer.byteLength(chunk)
        if (stderrBytes > limit) fail()
      })
      child.stdout.once('error', fail)
      child.stderr.once('error', fail)
      child.once('error', () => {
        failed = true
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        resolve(!failed && code === 0 && flags.trusted())
      })
    })
  } catch {
    return false
  }
}
