import { existsSync, realpathSync, statSync } from 'node:fs'
import { readDesignArtifact, writeDesignArtifact } from './artifact-store.js'
import {
  containedWorkspaceFile,
  normalizeWorkspaceFile,
  readWorkspaceFile,
} from './workspace-files.js'
import path from 'node:path'
import { readRasterMetadata } from './raster-metadata.js'
import type { PageBlueprint } from './page.js'
import { member, optionalString, record, string, strings } from './parse.js'

const ASSET_KINDS = ['image', 'illustration', 'video', 'icon', 'font', 'component', 'data'] as const
const ASSET_STATUSES = ['existing', 'needed', 'ready'] as const
const SOURCE_KINDS = ['project', 'user', 'origin-kit', 'generated', 'external'] as const
const ASSET_ROLES = [
  'photography',
  'product_image',
  'editorial_illustration',
  'interface_capture',
  'functional_icon',
  'logo',
  'data_diagram',
  'video',
  'font',
  'component',
  'data',
] as const

export type AssetKind = (typeof ASSET_KINDS)[number]
export type AssetStatus = (typeof ASSET_STATUSES)[number]
export type AssetSourceKind = (typeof SOURCE_KINDS)[number]
export type AssetRole = (typeof ASSET_ROLES)[number]

const RASTER_VISUAL_ROLES = new Set<AssetRole>([
  'photography',
  'product_image',
  'editorial_illustration',
  'interface_capture',
])
const SVG_ROLES = new Set<AssetRole>(['functional_icon', 'logo', 'data_diagram'])
const GENERATED_FUNCTIONAL_ROLES = new Set<AssetRole>([
  'interface_capture',
  'functional_icon',
  'logo',
  'data_diagram',
])
const PRODUCTION_RASTER_SOURCES = new Set<AssetSourceKind>(['generated', 'external'])

export interface DesignAsset {
  id: string
  kind: AssetKind
  status: AssetStatus
  purpose: string
  requirements: string[]
  role?: AssetRole
  sectionIds?: string[]
  aspectRatio?: string
  composition?: string
  source?: {
    kind: AssetSourceKind
    reference: string
    license?: string
  }
  destination?: string
}

export interface AssetManifest {
  version: 1
  assets: DesignAsset[]
}

export function parseAssetManifest(value: unknown): AssetManifest {
  const manifest = record(value, 'asset manifest')
  if (manifest.version !== 1) throw new Error('asset manifest version must be 1')
  if (!Array.isArray(manifest.assets)) throw new Error('assets must be an array')
  if (manifest.assets.length > 256) throw new Error('asset manifest exceeds 256 records')

  const assets = manifest.assets.map((value, index) => {
    const asset = record(value, `assets[${index}]`)
    const status = member(asset.status, ASSET_STATUSES, `assets[${index}].status`)
    const source = optionalSource(asset.source, `assets[${index}].source`)
    const destination = optionalString(asset.destination, `assets[${index}].destination`)
    const role =
      asset.role === undefined
        ? undefined
        : member(asset.role, ASSET_ROLES, `assets[${index}].role`)
    const sectionIds =
      asset.sectionIds === undefined
        ? undefined
        : strings(asset.sectionIds, `assets[${index}].sectionIds`)
    const aspectRatio = optionalString(asset.aspectRatio, `assets[${index}].aspectRatio`)
    const composition = optionalString(asset.composition, `assets[${index}].composition`)
    // Model-authored and later handed to the Build agent as a write target:
    // absolute paths and .. segments must never leave the workspace.
    if (destination !== undefined && !normalizeWorkspaceFile(destination)) {
      throw new Error(`assets[${index}].destination must stay inside the workspace`)
    }

    if (status === 'ready' && (!source || !destination)) {
      throw new Error(`assets[${index}] ready assets require source and destination`)
    }
    if (status === 'existing' && !source) {
      throw new Error(`assets[${index}] existing assets require a source`)
    }
    if (status === 'ready' && source?.kind === 'external' && !source.license) {
      throw new Error(`assets[${index}] ready external assets require a license`)
    }
    if (aspectRatio) {
      const parts = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(aspectRatio)
      if (
        !parts ||
        !parts.slice(1).every((part) => Number.isFinite(Number(part)) && Number(part) > 0)
      ) {
        throw new Error(`assets[${index}].aspectRatio must use positive width:height`)
      }
    }

    return {
      id: string(asset.id, `assets[${index}].id`),
      kind: member(asset.kind, ASSET_KINDS, `assets[${index}].kind`),
      status,
      purpose: string(asset.purpose, `assets[${index}].purpose`),
      requirements: strings(asset.requirements, `assets[${index}].requirements`),
      ...(role ? { role } : {}),
      ...(sectionIds ? { sectionIds } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(composition ? { composition } : {}),
      ...(source ? { source } : {}),
      ...(destination ? { destination } : {}),
    }
  })

  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    throw new Error('asset ids must be unique')
  }

  return { version: 1, assets }
}

/**
 * Cross-artifact validation for the Asset phase. The loose parser above stays
 * backwards compatible for persisted manifests; new phase output must prove
 * exact page coverage and enough visual intent for Build to use the real asset.
 */
export function validateAssetManifestForPage(
  manifest: AssetManifest,
  page: PageBlueprint,
  workspacePath?: string,
  suppliedReferences: readonly string[] = [],
): AssetManifest {
  const expected = new Map<string, { kind: 'asset' | 'component'; sectionIds: Set<string> }>()
  for (const section of page.sections) {
    for (const [kind, ids] of [
      ['asset', section.assetNeeds],
      ['component', section.componentNeeds],
    ] as const) {
      for (const id of ids) {
        const previous = expected.get(id)
        if (previous && previous.kind !== kind) {
          throw new Error(`page need ${id} cannot be both an asset and a component`)
        }
        const entry = previous ?? { kind, sectionIds: new Set<string>() }
        entry.sectionIds.add(section.id)
        expected.set(id, entry)
      }
    }
  }

  // Brand fonts can serve several sections without a separate page-level asset need.
  const pageSectionIds = new Set(page.sections.map(({ id }) => id))
  for (const asset of manifest.assets) {
    if (asset.kind !== 'font' || asset.role !== 'font' || expected.has(asset.id)) continue
    if (!asset.sectionIds?.length || asset.sectionIds.some((id) => !pageSectionIds.has(id))) {
      throw new Error(`font asset ${asset.id} must name existing consuming page sections`)
    }
    expected.set(asset.id, { kind: 'asset', sectionIds: new Set(asset.sectionIds) })
  }

  const actualIds = new Set(manifest.assets.map(({ id }) => id))
  const missing = [...expected.keys()].filter((id) => !actualIds.has(id)).sort()
  const extra = manifest.assets
    .map(({ id }) => id)
    .filter((id) => !expected.has(id))
    .sort()
  if (missing.length || extra.length) {
    throw new Error(
      [
        'asset manifest must match page needs exactly',
        missing.length ? `missing: ${missing.join(', ')}` : '',
        extra.length ? `extra: ${extra.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    )
  }

  const workspaceRoot = workspacePath ? realpathSync(workspacePath) : undefined
  const suppliedReferenceFiles = new Map<string, string>(
    suppliedReferences.map((filePath, index) => {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        throw new Error(`supplied reference user-reference-${index + 1} does not exist`)
      }
      return [`user-reference-${index + 1}`, realpathSync(filePath)] as const
    }),
  )

  let totalBytes = 0
  for (const [index, asset] of manifest.assets.entries()) {
    const need = expected.get(asset.id)!
    if (!asset.role) throw new Error(`assets[${index}].role is required for page validation`)
    if (!asset.sectionIds?.length) {
      throw new Error(`assets[${index}].sectionIds must name every consuming page section`)
    }
    const declaredSections = new Set(asset.sectionIds)
    if (
      declaredSections.size !== asset.sectionIds.length ||
      !sameSet(declaredSections, need.sectionIds)
    ) {
      throw new Error(
        `assets[${index}].sectionIds must exactly match ${[...need.sectionIds].sort().join(', ')}`,
      )
    }
    if (need.kind === 'component') {
      if (asset.kind !== 'component' || asset.role !== 'component') {
        throw new Error(`component need ${asset.id} must use kind and role component`)
      }
    } else if (asset.kind === 'component' || asset.role === 'component') {
      throw new Error(`asset need ${asset.id} cannot use kind or role component`)
    }
    const requiredKind =
      asset.role === 'font' || asset.role === 'video' || asset.role === 'data'
        ? asset.role
        : undefined
    if (
      (requiredKind && asset.kind !== requiredKind) ||
      (RASTER_VISUAL_ROLES.has(asset.role) && !['image', 'illustration'].includes(asset.kind))
    ) {
      throw new Error(`asset ${asset.id} kind does not match role ${asset.role}`)
    }

    if (RASTER_VISUAL_ROLES.has(asset.role)) {
      if (!asset.aspectRatio || !asset.composition) {
        throw new Error(
          `visual asset ${asset.id} requires exact aspectRatio and composition fields`,
        )
      }
    }
    if (asset.source?.kind === 'generated' && GENERATED_FUNCTIONAL_ROLES.has(asset.role)) {
      throw new Error(`functional asset ${asset.id} cannot use a generated source`)
    }

    if (workspaceRoot) {
      let localFile: string | undefined
      if (asset.source?.kind === 'project') {
        const reference = asset.source.reference
        if (/^(?:[a-z]:|[\\/])/i.test(reference) || reference.split(/[\\/]/).includes('..')) {
          throw new Error(`project asset ${asset.id} source must stay inside the workspace`)
        }
        const projectFile = containedWorkspaceFile(
          workspaceRoot,
          reference,
          `project asset ${asset.id} source`,
        )
        if (asset.status === 'existing') {
          localFile = projectFile
        }
      }
      if (asset.source?.kind === 'user') {
        const userFile = suppliedReferenceFiles.get(asset.source.reference)
        if (!userFile) {
          throw new Error(`user asset ${asset.id} source must use an attached user-reference-# ID`)
        }
        if (asset.status === 'existing') {
          if (!asset.destination) {
            throw new Error(
              `user asset ${asset.id} requires a workspace destination; copy the supplied file first`,
            )
          }
          localFile = containedWorkspaceFile(
            workspaceRoot,
            asset.destination,
            `asset ${asset.id} destination`,
          )
        }
      }
      if (asset.status === 'ready') {
        localFile = containedWorkspaceFile(
          workspaceRoot,
          asset.destination!,
          `asset ${asset.id} destination`,
        )
      } else if (asset.status === 'existing' && RASTER_VISUAL_ROLES.has(asset.role)) {
        if (asset.source?.kind !== 'project' && asset.source?.kind !== 'user') {
          throw new Error(
            `existing visual asset ${asset.id} must be a real project or supplied user file`,
          )
        }
      }
      if (localFile) {
        const size = statSync(localFile).size
        totalBytes += size
        if (!size) throw new Error(`asset ${asset.id} file is empty`)
        if (size > 32_000_000 || totalBytes > 128_000_000)
          throw new Error('Design assets exceed the 32 MB per-file or 128 MB total limit')
        if (asset.source?.kind === 'user') {
          const original = suppliedReferenceFiles.get(asset.source.reference)!
          if (
            !readWorkspaceFile(original, 32_000_000).equals(
              readWorkspaceFile(localFile, 32_000_000),
            )
          ) {
            throw new Error(
              `user asset ${asset.id} destination must contain the supplied file unchanged`,
            )
          }
        }
      }
      if (localFile && isSvg(localFile) && !SVG_ROLES.has(asset.role)) {
        throw new Error(
          `asset ${asset.id} is SVG content but role ${asset.role} requires a real raster or video asset`,
        )
      }
      if (localFile && RASTER_VISUAL_ROLES.has(asset.role)) {
        validateRasterAsset(asset, localFile)
      }
      if (localFile && asset.role === 'data') {
        try {
          JSON.parse(readWorkspaceFile(localFile, 1_000_000).toString('utf8'))
        } catch {
          throw new Error(`data asset ${asset.id} must contain valid JSON within 1 MB`)
        }
      }
    }
  }
  return manifest
}

export function validateResolvedDesignAssets(manifest: AssetManifest): AssetManifest {
  const unresolved = manifest.assets
    .filter(
      (asset) =>
        asset.role !== undefined &&
        (RASTER_VISUAL_ROLES.has(asset.role) || asset.role === 'video') &&
        asset.status === 'needed',
    )
    .map(({ id }) => id)
    .sort()
  if (unresolved.length) {
    throw new Error(
      `meaningful visual assets remain unresolved; Build must fail instead of substituting SVG or generic filler: ${unresolved.join(', ')}`,
    )
  }
  return manifest
}

export function readAssetManifest(workspacePath: string): AssetManifest {
  return parseAssetManifest(readDesignArtifact(workspacePath, 'assets.json'))
}

export function writeAssetManifest(workspacePath: string, value: unknown): AssetManifest {
  const manifest = parseAssetManifest(value)
  writeDesignArtifact(workspacePath, 'assets.json', manifest)
  return manifest
}

function optionalSource(value: unknown, field: string): DesignAsset['source'] {
  if (value === undefined) return undefined
  const source = record(value, field)
  const license = optionalString(source.license, `${field}.license`)
  const kind = member(source.kind, SOURCE_KINDS, `${field}.kind`)
  const reference = string(source.reference, `${field}.reference`)
  if (kind === 'external') {
    let url: URL
    try {
      url = new URL(reference)
    } catch {
      throw new Error(`${field}.reference must be an HTTP source page URL`)
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error(`${field}.reference must be an HTTP source page URL without credentials`)
    }
  }
  return {
    kind,
    reference,
    ...(license ? { license } : {}),
  }
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function isSvg(filePath: string): boolean {
  if (path.extname(filePath).toLowerCase() === '.svg') return true
  return readWorkspaceFile(filePath, 32_000_000)
    .subarray(0, 1024)
    .toString('utf8')
    .toLowerCase()
    .includes('<svg')
}

function validateRasterAsset(asset: DesignAsset, filePath: string): void {
  const metadata = readRasterMetadata(filePath)
  const extensionFormat = new Map([
    ['.png', 'png'],
    ['.jpg', 'jpeg'],
    ['.jpeg', 'jpeg'],
    ['.webp', 'webp'],
    ['.gif', 'gif'],
  ]).get(path.extname(filePath).toLowerCase())
  if (extensionFormat && extensionFormat !== metadata.format) {
    throw new Error(
      `visual asset ${asset.id} extension does not match its ${metadata.format} file content`,
    )
  }

  const [declaredWidth, declaredHeight] = asset.aspectRatio!.split(':').map(Number)
  const declaredRatio = declaredWidth! / declaredHeight!
  const actualRatio = metadata.width / metadata.height
  if (Math.abs(actualRatio / declaredRatio - 1) > 0.02) {
    throw new Error(
      `visual asset ${asset.id} is ${metadata.width}:${metadata.height}, not declared ${asset.aspectRatio}`,
    )
  }

  const pixels = metadata.width * metadata.height
  const longEdge = Math.max(metadata.width, metadata.height)
  const shortEdge = Math.min(metadata.width, metadata.height)
  if (pixels < 160_000 || shortEdge < 180) {
    throw new Error(
      `visual asset ${asset.id} is too small for production use (${metadata.width}x${metadata.height})`,
    )
  }
  if (
    asset.source &&
    PRODUCTION_RASTER_SOURCES.has(asset.source.kind) &&
    (pixels < 700_000 || longEdge < 960 || shortEdge < 360)
  ) {
    throw new Error(
      `generated or external visual asset ${asset.id} must be at least 960px on its long edge, 360px on its short edge, and 0.7 megapixels`,
    )
  }
}
