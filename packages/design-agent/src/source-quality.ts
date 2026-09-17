import { createHash } from 'node:crypto'
import path from 'node:path'
import type { AssetManifest } from './assets.js'
import type { PageBlueprint } from './page.js'
import {
  containedWorkspaceFile,
  readWorkspaceFile,
  workspaceEntries,
  normalizeWorkspaceFile,
} from './workspace-files.js'

export class DesignSourceQualityError extends Error {}

/** Reject the recurring generated card-rail motif before Preview and after Repair. */
export function validateDesignSourceQuality(
  workspacePath: string,
  reportedFiles: readonly string[] = [],
  baseline: readonly string[] = [],
  assets?: AssetManifest,
  page?: PageBlueprint,
): void {
  for (const file of reportedFiles)
    containedWorkspaceFile(workspacePath, file, 'reported Build file')
  const previous = new Map<string, number>()
  for (const violation of baseline) previous.set(violation, (previous.get(violation) ?? 0) + 1)
  // Source patterns cannot distinguish a copied reference border from invented decoration.
  // Reference-bound geometry is judged against the actual images in visual Review.
  const referenceBound =
    !!page?.sections.length && page.sections.every((section) => section.referenceDirectionId)
  const violations = designSourceViolations(workspacePath, assets, referenceBound).filter(
    (violation) => {
      const remaining = previous.get(violation) ?? 0
      if (!remaining) return true
      previous.set(violation, remaining - 1)
      return false
    },
  )
  if (violations.length) {
    throw new DesignSourceQualityError(
      `design source quality failed; remove newly introduced card rails or unmanifested SVG substitutes: ${violations.join('; ')}`,
    )
  }
}

export function designSourceQualityBaseline(
  workspacePath: string,
  assets?: AssetManifest,
): string[] {
  return designSourceViolations(workspacePath, assets)
}

function designSourceViolations(
  workspacePath: string,
  assets?: AssetManifest,
  referenceBound = false,
): string[] {
  const violations: string[] = []
  const cardRails: string[] = []
  const approvedSvgFiles = new Set(
    (assets?.assets ?? []).flatMap((asset) => {
      if (!asset.role || !['functional_icon', 'logo', 'data_diagram'].includes(asset.role)) {
        return []
      }
      const approvedPath =
        asset.status === 'ready' && asset.source && asset.destination
          ? asset.destination
          : asset.status === 'existing' && asset.source?.kind === 'project'
            ? asset.source.reference
            : undefined
      const normalized = approvedPath ? normalizeWorkspaceFile(approvedPath) : undefined
      return normalized &&
        ['.svg', '.html', '.jsx', '.tsx', '.vue', '.svelte'].includes(
          path.extname(normalized).toLowerCase(),
        )
        ? [normalized]
        : []
    }),
  )
  let totalBytes = 0
  for (const normalized of designSourceFiles(workspacePath)) {
    const extension = path.extname(normalized).toLowerCase()
    const absolute = path.join(workspacePath, normalized)
    const bytes = readWorkspaceFile(absolute, 2_000_000)
    totalBytes += bytes.length
    if (totalBytes > 32_000_000)
      throw new Error('Design source scan exceeds 32 MB; reduce the workspace scope')
    const source = bytes.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, '')

    if (extension === '.svg') {
      if (!approvedSvgFiles.has(normalized)) {
        violations.push(
          `${normalized}: unmanifested standalone SVG substitute ${sourceFingerprint(source)}`,
        )
      }
      continue
    }

    if (['.css', '.scss', '.sass', '.less'].includes(extension)) {
      scanCssCardRails(source, normalized, cardRails)
    } else if (extension === '.vue' || extension === '.svelte' || extension === '.html') {
      for (const style of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
        scanCssCardRails(style[1]!, normalized, cardRails)
      }
    } else {
      for (const match of source.matchAll(/(?:css|styled(?:\.\w+|\([^)]*\)))\s*`([\s\S]*?)`/g)) {
        const css = match[1] ?? ''
        scanCssCardRails(css, normalized, cardRails)
        const declarationContext = source.slice(Math.max(0, match.index! - 160), match.index)
        if (isCardLike(declarationContext)) {
          scanCssCardRails(`.generated-card { ${css} }`, normalized, cardRails)
        }
      }
    }
    scanMarkupCardRails(source, normalized, cardRails)
    if (!approvedSvgFiles.has(normalized)) {
      for (const match of source.matchAll(/<svg\b/gi)) {
        const start = match.index!
        const closing = source.indexOf('</svg>', start)
        const fragment = source.slice(start, closing < 0 ? start + 1_024 : closing + 6)
        violations.push(
          `${normalized}: unmanifested inline SVG substitute ${sourceFingerprint(fragment)}`,
        )
      }
    }
  }
  return (referenceBound ? violations : [...violations, ...cardRails]).sort()
}

function sourceFingerprint(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 12)
}

function scanCssCardRails(source: string, file: string, violations: string[]): void {
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1]?.trim() ?? '').slice(-200)
    const body = match[2] ?? ''
    if (!isCardLike(selector)) continue

    if (
      /\bborder-(?:left|right|inline-start|inline-end)(?:-width)?\s*:\s*(?!0(?:px|rem|em)?(?:\s|;|$)|none(?:\s|;|$))/i.test(
        body,
      )
    ) {
      violations.push(`${file}: ${selector} uses a one-sided card-edge border`)
    }
    if (/\bbox-shadow\s*:[^;]*\binset\b[^;]*(?:^|\s)-?(?:[1-8](?:\.\d+)?)px\s+0\b/i.test(body)) {
      violations.push(`${file}: ${selector} uses an inset card-edge rail`)
    }
    if (hasNarrowHorizontalGradientRail(body)) {
      violations.push(`${file}: ${selector} uses a narrow card-edge gradient rail`)
    }

    const fullBlock =
      /\bheight\s*:\s*100%/i.test(body) ||
      /\binset-block\s*:\s*0\b/i.test(body) ||
      (/\btop\s*:\s*0\b/i.test(body) && /\bbottom\s*:\s*0\b/i.test(body)) ||
      /\balign-self\s*:\s*stretch\b/i.test(body)
    const atEdge =
      /\b(?:left|right|inset-inline-start|inset-inline-end)\s*:\s*0\b/i.test(body) ||
      /::?(?:before|after)|(?:^|[\s>+~])(?::?(?:first|last)-child|\.[\w-]*(?:rail|strip|accent|rule))/i.test(
        selector,
      )
    const narrow =
      /\b(?:width|inline-size|flex-basis)\s*:\s*(?:[1-8](?:\.\d+)?px|0?\.\d+rem)\b/i.test(body)
    if (fullBlock && atEdge && (narrow || /::?(?:before|after)/i.test(selector))) {
      violations.push(`${file}: ${selector} draws a full-height narrow card-edge strip`)
    }
  }
}

function hasNarrowHorizontalGradientRail(body: string): boolean {
  for (const match of body.matchAll(
    /\b(?:background|background-image)\s*:\s*([^;]*linear-gradient\([^;]*\))/gi,
  )) {
    const gradient = match[1] ?? ''
    if (!/linear-gradient\(\s*(?:to\s+(?:left|right)|(?:90|270)deg)\b/i.test(gradient)) {
      continue
    }
    const smallStops = new Map<string, number>()
    for (const stop of gradient.matchAll(/(-?\d+(?:\.\d+)?)(px|rem|%)/gi)) {
      const value = Number(stop[1])
      const unit = stop[2]!.toLowerCase()
      const isNarrow =
        value >= 0 &&
        ((unit === 'px' && value <= 8) ||
          (unit === 'rem' && value <= 0.5) ||
          (unit === '%' && value <= 2))
      if (isNarrow) smallStops.set(unit, (smallStops.get(unit) ?? 0) + 1)
    }
    if ([...smallStops.values()].some((count) => count >= 2)) return true
  }
  return false
}

function scanMarkupCardRails(source: string, file: string, violations: string[]): void {
  for (const match of source.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]+)["'`]/g)) {
    const classes = match[1] ?? ''
    const tokens = classes.split(/\s+/).map((token) => token.replace(/^(?:[\w-]+:)+/u, ''))
    if (isCardLike(classes) && tokens.some((token) => /^border-(?:l|r|s|e)(?:-|$)/u.test(token))) {
      violations.push(`${file}: card-like class uses a one-sided border utility`)
    }

    const fullBlock =
      tokens.includes('inset-y-0') ||
      tokens.includes('self-stretch') ||
      (tokens.includes('top-0') && tokens.includes('bottom-0'))
    const atEdge = tokens.some((token) => /^(?:left|right|start|end)-0$/u.test(token))
    const narrow = tokens.some(
      (token) => token === 'w-px' || /^w-\[(?:[1-8](?:\.\d+)?)px\]$/u.test(token),
    )
    const nearby = source.slice(
      Math.max(0, match.index! - 600),
      match.index! + match[0].length + 600,
    )
    if (fullBlock && atEdge && narrow && isCardLike(nearby)) {
      violations.push(`${file}: card markup contains a full-height narrow edge strip`)
    }
  }

  for (const match of source.matchAll(
    /(?:borderLeft|borderRight|borderInlineStart|borderInlineEnd)\s*:\s*([^,}\n]+)/g,
  )) {
    const nearby = source.slice(Math.max(0, match.index! - 500), match.index! + 500)
    if (isCardLike(nearby) && !/^\s*(?:0|['"]none['"])/i.test(match[1] ?? '')) {
      violations.push(`${file}: card-like inline style uses a one-sided border`)
    }
  }
}

function isCardLike(value: string): boolean {
  return /(?:^|[\s.>+~#_\-"'])(?:card|tile|panel|step|feature|price|proof|testimonial|stat)(?:s|Card)?(?=$|[\s.>+~#_:\-"'])|(?:Card|Tile|Panel)\b/.test(
    value,
  )
}

function designSourceFiles(workspacePath: string): string[] {
  const extensions = new Set([
    '.css',
    '.scss',
    '.sass',
    '.less',
    '.html',
    '.js',
    '.mjs',
    '.cjs',
    '.jsx',
    '.ts',
    '.tsx',
    '.vue',
    '.svelte',
    '.svg',
  ])
  const ignoredDirectories = new Set([
    '.git',
    '.taste',
    '.next',
    '.turbo',
    'node_modules',
    'dist',
    'build',
    'out',
    'coverage',
    'vendor',
  ])
  return workspaceEntries(workspacePath, ignoredDirectories)
    .filter(
      ({ relative, file }) =>
        file &&
        extensions.has(path.extname(relative).toLowerCase()) &&
        !/(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\/)/i.test(relative),
    )
    .map(({ relative }) => relative)
}
