import { execFile } from 'node:child_process'
import type { ResultOf } from '@harness/contracts'

/**
 * Compare the running checkout against the GitHub default branch.
 *
 * Lives server-side because the renderer's CSP deliberately talks to one
 * local server and nothing else. Both halves are allowed to be unknowable —
 * a packaged build has no git history, and offline is a normal state, not an
 * exception — so the result names what it could not learn instead of
 * throwing.
 */

const REPO = 'Leonxlnx/personalharness'

type Probe = {
  head(): Promise<string | undefined>
  fetchLatest(): Promise<{ sha: string; message: string; date: string } | { error: string }>
}

const REAL_PROBE: Probe = {
  head: () =>
    new Promise((resolve) => {
      execFile('git', ['rev-parse', 'HEAD'], { windowsHide: true }, (error, stdout) =>
        resolve(error ? undefined : stdout.trim() || undefined),
      )
    }),
  fetchLatest: async () => {
    const response = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined)
    if (response?.ok) {
      const data = (await response.json()) as {
        sha?: string
        commit?: { message?: string; committer?: { date?: string } }
      }
      if (data.sha) {
        return {
          sha: data.sha,
          message: (data.commit?.message ?? '').split('\n')[0] ?? '',
          date: data.commit?.committer?.date ?? '',
        }
      }
    }
    // The repo is private (404 for anonymous callers) or GitHub is down.
    // git ls-remote uses the user's own credentials and answers with the sha
    // alone — less detail, but a correct verdict beats a rich error.
    return lsRemoteHead()
  },
}

function lsRemoteHead(): Promise<
  { sha: string; message: string; date: string } | { error: string }
> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-remote', 'origin', 'refs/heads/main'],
      { windowsHide: true, timeout: 10_000 },
      (error, stdout) => {
        const sha = stdout?.split(/\s/)[0]
        if (error || !sha) resolve({ error: 'Could not reach GitHub.' })
        else resolve({ sha, message: '', date: '' })
      },
    )
  })
}

export async function checkForUpdates(
  probe: Probe = REAL_PROBE,
): Promise<ResultOf<'system.updateCheck'>> {
  const localCommit = await probe.head()
  let latest: Awaited<ReturnType<Probe['fetchLatest']>>
  try {
    latest = await probe.fetchLatest()
  } catch {
    latest = { error: 'Could not reach GitHub.' }
  }

  if ('error' in latest) {
    return { ...(localCommit ? { localCommit } : {}), error: latest.error }
  }
  return {
    ...(localCommit ? { localCommit } : {}),
    remote: latest,
    ...(localCommit ? { upToDate: localCommit === latest.sha } : {}),
  }
}
