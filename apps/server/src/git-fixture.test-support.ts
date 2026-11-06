import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Removes a test folder. A Windows runner's virus scanner, or a git process that is just
 * exiting, can hold a file for a moment and fail rmdir with EBUSY; Node retries then.
 */
export function removeTestFolder(folder: string): void {
  rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}

/**
 * A committed repository built once per test file and copied for each test. Starting git is
 * the slow part on Windows runners: six processes before every test made the git-heavy files
 * take minutes there and starved the files running beside them. A copied repository is the
 * same repository; git refreshes the copied index stat data on its first read.
 */
export function gitRepositoryTemplate(prefix: string, files: Record<string, string>) {
  let template: string | undefined
  /** Three git processes, once per test file. */
  const build = (): string => {
    if (template) return template
    const folder = mkdtempSync(path.join(os.tmpdir(), `${prefix}template-`))
    execFileSync('git', ['init', '-b', 'main', folder], { windowsHide: true })
    // Written straight into the repository's config: one `git config` process each was the
    // larger part of the setup.
    appendFileSync(
      path.join(folder, '.git', 'config'),
      [
        '[user]',
        '\temail = test@example.com',
        '\tname = Test',
        // Otherwise git rewrites line endings on checkout and assertions pass on macOS only.
        '[core]',
        '\tautocrlf = false',
        // No automatic gc or maintenance running on in the background, holding the folder.
        '[gc]',
        '\tauto = 0',
        '\tautoDetach = false',
        '[maintenance]',
        '\tauto = false',
        '',
      ].join('\n'),
    )
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(folder, file)), { recursive: true })
      writeFileSync(path.join(folder, file), text)
    }
    execFileSync('git', ['add', '.'], { cwd: folder, windowsHide: true })
    execFileSync('git', ['commit', '-m', 'first'], { cwd: folder, windowsHide: true })
    template = folder
    return folder
  }
  return {
    /** Builds the template; call it from beforeAll, so no test's own hook pays for it. */
    build,
    /** A fresh copy of the template in its own temp folder. */
    create(): string {
      const repo = mkdtempSync(path.join(os.tmpdir(), prefix))
      cpSync(build(), repo, { recursive: true })
      return repo
    },
    dispose(): void {
      if (template) removeTestFolder(template)
      template = undefined
    },
  }
}
