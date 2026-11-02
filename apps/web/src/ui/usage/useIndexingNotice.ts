import { useState } from 'react'
import type { ResultOf } from '@harness/contracts'

type History = ResultOf<'usage.history'>

/**
 * Whether the usage history should say it is indexing. A first index, with
 * nothing to show yet, says so at once. A routine refresh of an existing
 * index usually ends before the next poll; announcing it on the first read
 * flashed a notice that pushed the page down and back up on every visit. So
 * a refresh is announced only once a later read still finds it running.
 */
export function useIndexingNotice(data: History | undefined): boolean {
  const scanning = data?.scan.status === 'scanning'
  // The first read that found the current scan running.
  const [firstRead, setFirstRead] = useState<History | undefined>(undefined)
  if (scanning && firstRead === undefined) setFirstRead(data)
  else if (!scanning && firstRead !== undefined) setFirstRead(undefined)
  if (!scanning) return false
  return data.generatedAt === 0 || (firstRead !== undefined && firstRead !== data)
}
