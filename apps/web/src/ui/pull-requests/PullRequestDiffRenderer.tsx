import { useMemo, type ReactNode } from 'react'
import {
  parsePatchFiles,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type FileDiffOptions,
} from '@pierre/diffs'
import { FileDiff } from '@pierre/diffs/react'
import type { PullRequestFile, PullRequestReviewThread } from '@harness/contracts'
import { pullRequestFilePatch } from './diffs-patch.js'

export type PullRequestDiffSide = 'deletions' | 'additions'

export type PullRequestReviewAnnotation =
  { kind: 'thread'; thread: PullRequestReviewThread } | { kind: 'composer' }

export type PullRequestDiffAnnotation = DiffLineAnnotation<PullRequestReviewAnnotation>

const HARNESS_DIFF_CSS = `
  :host {
    --diffs-font-family: var(--font-mono);
    --diffs-header-font-family: var(--font-ui);
    --diffs-font-size: var(--t-xs);
    --diffs-line-height: 22px;
    --diffs-light-bg: var(--chrome-recessed);
    --diffs-dark-bg: var(--chrome-recessed);
    --diffs-light: var(--text-2);
    --diffs-dark: var(--text-2);
    --diffs-addition-color: var(--success);
    --diffs-deletion-color: var(--error);
    --diffs-modified-color: var(--attention);
    --diffs-selection-base: var(--surface-2);
    --diffs-bg-context-override: var(--chrome-recessed);
    --diffs-bg-context-gutter-override: color-mix(in srgb, var(--surface-2) 72%, var(--chrome-recessed));
    --diffs-bg-separator-override: var(--surface-2);
    --diffs-fg-number-override: var(--text-3);
    --diffs-gap-inline: 8px;
    --diffs-gap-block: 6px;
    background: var(--chrome-recessed);
  }

  [data-separator] {
    border-block-color: var(--line);
  }

  [data-line-annotation],
  [data-gutter-buffer='annotation'] {
    --diffs-annotation-bg: var(--bg);
  }

  [data-gutter-utility-slot] {
    align-items: center;
    justify-content: flex-start;
    left: 0;
    right: auto;
    padding-left: 7px;
  }

  [data-utility-button] {
    width: 20px;
    height: 20px;
    margin: 0;
    background: color-mix(in srgb, var(--surface-2) 82%, transparent);
    border: 1px solid var(--line-strong);
    border-radius: var(--r-md);
    box-shadow: none;
    color: var(--text-2);
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out);
  }

  [data-utility-button]:hover,
  [data-utility-button]:focus-visible {
    background: var(--surface-3);
    border-color: var(--line-strong);
    color: var(--text);
  }

  [data-utility-button]:focus-visible {
    outline: 1px solid var(--line-strong);
    outline-offset: 1px;
  }
`

export type PullRequestDiffRendererProps = {
  file: PullRequestFile
  cacheKey: string
  annotations: PullRequestDiffAnnotation[]
  renderAnnotation: (annotation: PullRequestDiffAnnotation) => ReactNode
  onCommentLine: (target: { lineNumber: number; side: PullRequestDiffSide }) => void
}

export function PullRequestDiffRenderer(props: PullRequestDiffRendererProps) {
  const fileDiff = useMemo(
    () => parseFileDiff(props.file, props.cacheKey),
    [props.cacheKey, props.file],
  )
  const themeType =
    globalThis.document?.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
  const options = useMemo<FileDiffOptions<PullRequestReviewAnnotation>>(
    () => ({
      diffStyle: 'unified',
      diffIndicators: 'bars',
      disableFileHeader: true,
      hunkSeparators: 'line-info-basic',
      lineDiffType: 'word-alt',
      overflow: 'scroll',
      preferredHighlighter: 'shiki-js',
      theme: { dark: 'github-dark', light: 'github-light' },
      themeType,
      unsafeCSS: HARNESS_DIFF_CSS,
      lineHoverHighlight: 'line',
      enableGutterUtility: true,
      onGutterUtilityClick: (range) => {
        props.onCommentLine({
          lineNumber: range.start,
          side: range.side === 'deletions' ? 'deletions' : 'additions',
        })
      },
    }),
    [props.onCommentLine, themeType],
  )

  if (!fileDiff) return <div className="pr-diffs-error">Diffs could not parse this patch.</div>

  return (
    <FileDiff<PullRequestReviewAnnotation>
      fileDiff={fileDiff}
      options={options}
      // Own the selection so the gutter "+" never stays pinned after a click.
      selectedLines={null}
      lineAnnotations={props.annotations}
      renderAnnotation={props.renderAnnotation}
      className="pr-diffs-renderer"
      disableWorkerPool
    />
  )
}

function parseFileDiff(file: PullRequestFile, cacheKey: string): FileDiffMetadata | undefined {
  try {
    const patches = parsePatchFiles(pullRequestFilePatch(file), cacheKey, true)
    return patches.length === 1 && patches[0]?.files.length === 1 ? patches[0].files[0] : undefined
  } catch {
    return undefined
  }
}
