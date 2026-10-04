import { useMemo, type ReactNode } from 'react'
import type { Transport } from '../../transport.js'
import { MarkdownImageContext } from '../MarkdownImage.js'
import { pullRequestImageUrl, resolvePullRequestImage } from './pull-request-image-source.js'

export function PullRequestImages({
  transport,
  repository,
  refOid,
  children,
}: {
  transport: Transport
  repository?: string
  refOid?: string
  children: ReactNode
}) {
  const images = useMemo(
    () => ({
      normalize: (source: string) => pullRequestImageUrl(source, repository, refOid),
      resolve: (source: string) => resolvePullRequestImage(transport, source),
    }),
    [transport, repository, refOid],
  )

  return <MarkdownImageContext.Provider value={images}>{children}</MarkdownImageContext.Provider>
}
