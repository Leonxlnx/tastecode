import type { PullRequestFile } from '@harness/contracts'

/** GitHub's per-file `patch` omits the file headers that Diffs expects. */
export function pullRequestFilePatch(file: PullRequestFile): string {
  const previousPath = file.previousPath ?? file.path
  const oldPath = file.status === 'added' ? '/dev/null' : previousPath
  const newPath = file.status === 'removed' ? '/dev/null' : file.path
  return `--- ${oldPath}\n+++ ${newPath}\n${file.patch ?? ''}`
}
