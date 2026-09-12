import { execFileSync } from 'node:child_process'
import { assertCommitSha, isMain, repositoryRoot } from './release-manifest.js'

export function verifyReleaseInput({
  approvedSha,
  eventSha,
  eventRef,
  checkoutSha,
  dirty = false,
}) {
  assertCommitSha(approvedSha)
  assertCommitSha(eventSha)
  assertCommitSha(checkoutSha)
  if (eventRef !== 'refs/heads/main')
    throw new Error('Release proof must be dispatched from refs/heads/main')
  if (approvedSha !== eventSha || approvedSha !== checkoutSha)
    throw new Error('Approved SHA must equal both the selected main commit and checkout HEAD')
  if (dirty) throw new Error('Release proof requires a clean source checkout')
  return approvedSha
}

export function verifyReleaseCheckout(env = process.env) {
  const git = (args) =>
    execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }).trim()
  return verifyReleaseInput({
    approvedSha: env.APPROVED_SHA,
    eventSha: env.EVENT_SHA,
    eventRef: env.EVENT_REF,
    checkoutSha: git(['rev-parse', 'HEAD']),
    dirty: git(['status', '--porcelain', '--untracked-files=normal']).length !== 0,
  })
}

if (isMain(import.meta.url))
  console.log(`Approved exact clean main commit ${verifyReleaseCheckout()}`)
