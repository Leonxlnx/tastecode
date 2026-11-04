import { z } from 'zod'

/**
 * Git refuses a repository whose `.git` belongs to another user, and exits the
 * same way it does in a folder that is no repository at all. Codex's Windows
 * sandbox runs commands as an account of its own, so a `git init` made there
 * leaves a repository the user's own git will not open.
 *
 * Nothing here trusts the folder for them: `safe.directory` is a security
 * setting, and changing it is the user's decision.
 */
export class DubiousOwnership extends Error {
  constructor(
    readonly repoPath: string,
    /** The account git names as the owner. Only Git for Windows names one. */
    readonly owner: string | undefined,
    /** The command git suggests, exactly as it printed it. */
    readonly fix: string | undefined,
  ) {
    super(
      (owner
        ? `Git refuses to use ${repoPath} because the repository belongs to another Windows user (${owner}).`
        : `Git refuses to use ${repoPath} because it cannot confirm that the repository belongs to the current user.`) +
        (fix ? ` Git's own fix: ${fix}` : ''),
    )
    this.name = 'DubiousOwnership'
  }
}

/**
 * The ownership refusal in a failed git run, or undefined when git failed for
 * another reason. Takes git's stderr, or the error of an `execFile` run.
 */
export function ownershipRefusal(repoPath: string, failure: unknown): DubiousOwnership | undefined {
  const stderr =
    typeof failure === 'string'
      ? failure
      : (z.object({ stderr: z.string() }).safeParse(failure).data?.stderr ??
        (failure instanceof Error ? failure.message : ''))
  // Git's own wording for this refusal, on every platform.
  if (!stderr.includes('detected dubious ownership')) return undefined
  const lines = stderr.split(/\r?\n/)
  // "'<path>/.git' is owned by:" and then "\t<DOMAIN/user> (<SID>)", where a
  // name Windows cannot resolve reads "(inconvertible)".
  const ownedBy = lines.findIndex((line) => line.trimEnd().endsWith('is owned by:'))
  const owned = ownedBy < 0 ? null : /^\s*(.+?) \(.+\)\s*$/.exec(lines[ownedBy + 1] ?? '')
  const owner = owned?.[1] && !owned[1].startsWith('(') ? owned[1] : undefined
  const fix = lines
    .map((line) => line.trim())
    .find((line) => line.startsWith('git config --global --add safe.directory '))
  return new DubiousOwnership(repoPath, owner, fix)
}
