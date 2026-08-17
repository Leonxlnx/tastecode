import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertCommitSha } from './release-manifest.js'

export function verifyReleaseInput({ approvedSha, eventSha, eventRef }) {
  assertCommitSha(approvedSha)
  assertCommitSha(eventSha)

  if (eventRef !== 'refs/heads/main') {
    throw new Error(`Release proof must be dispatched from refs/heads/main, got ${eventRef}`)
  }

  if (approvedSha !== eventSha) {
    throw new Error(
      `Approved SHA ${approvedSha} must equal the main commit selected for this run ${eventSha}`,
    )
  }

  return approvedSha
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  const approvedSha = verifyReleaseInput({
    approvedSha: process.env.APPROVED_SHA,
    eventSha: process.env.EVENT_SHA,
    eventRef: process.env.EVENT_REF,
  })
  console.log(`Approved exact main commit ${approvedSha}`)
}
