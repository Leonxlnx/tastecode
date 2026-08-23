import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PageBlueprint } from './page.js'
import { member, optionalString, record, string, strings } from './parse.js'

const ASSET_KINDS = ['image', 'illustration', 'video', 'icon', 'font', 'component'] as const
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

interface RasterMetadata {
  format: 'png' | 'jpeg' | 'webp' | 'gif'
  width: number
  height: number
}

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
    if (
      destination !== undefined &&
      (/^(?:[a-z]:|[\\/])/i.test(destination) || destination.split(/[\\/]/).includes('..'))
    ) {
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
      if (!parts || Number(parts[1]) <= 0 || Number(parts[2]) <= 0) {
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
        if (asset.status === 'existing' && RASTER_VISUAL_ROLES.has(asset.role)) {
          localFile = projectFile
        }
      }
      if (asset.source?.kind === 'user') {
        const userFile = suppliedReferenceFiles.get(asset.source.reference)
        if (!userFile) {
          throw new Error(`user asset ${asset.id} source must use an attached user-reference-# ID`)
        }
        if (asset.status === 'existing' && RASTER_VISUAL_ROLES.has(asset.role)) {
          localFile = userFile
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
      if (localFile && isSvg(localFile) && !SVG_ROLES.has(asset.role)) {
        throw new Error(
          `asset ${asset.id} is SVG content but role ${asset.role} requires a real raster or video asset`,
        )
      }
      if (localFile && RASTER_VISUAL_ROLES.has(asset.role)) {
        validateRasterAsset(asset, localFile)
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
        RASTER_VISUAL_ROLES.has(asset.role) &&
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
  return parseAssetManifest(JSON.parse(readFileSync(assetPath(workspacePath), 'utf8')))
}

export function writeAssetManifest(workspacePath: string, value: unknown): AssetManifest {
  const manifest = parseAssetManifest(value)
  const outputPath = assetPath(workspacePath)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function assetPath(workspacePath: string): string {
  return path.join(workspacePath, '.taste', 'assets.json')
}

function optionalSource(value: unknown, field: string): DesignAsset['source'] {
  if (value === undefined) return undefined
  const source = record(value, field)
  const license = optionalString(source.license, `${field}.license`)
  return {
    kind: member(source.kind, SOURCE_KINDS, `${field}.kind`),
    reference: string(source.reference, `${field}.reference`),
    ...(license ? { license } : {}),
  }
}

function sameSet(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}

function isSvg(filePath: string): boolean {
  if (path.extname(filePath).toLowerCase() === '.svg') return true
  return readFileSync(filePath).subarray(0, 1024).toString('utf8').toLowerCase().includes('<svg')
}

function containedWorkspaceFile(
  workspaceRoot: string,
  relativePath: string,
  label: string,
): string {
  const candidate = path.join(workspaceRoot, relativePath)
  if (!existsSync(candidate) || !statSync(candidate).isFile()) {
    throw new Error(`${label} does not exist`)
  }
  if (statSync(candidate).size === 0) throw new Error(`${label} is empty`)
  const resolved = realpathSync(candidate)
  const relative = path.relative(workspaceRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the workspace after resolving symlinks`)
  }
  return resolved
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

function readRasterMetadata(filePath: string): RasterMetadata {
  const buffer = readFileSync(filePath)
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.subarray(0, 8).equals(pngSignature)) {
    if (
      buffer.length < 45 ||
      buffer.readUInt32BE(8) !== 13 ||
      buffer.subarray(12, 16).toString('ascii') !== 'IHDR' ||
      buffer.indexOf(Buffer.from('IDAT'), 24) < 0 ||
      buffer.subarray(buffer.length - 8, buffer.length - 4).toString('ascii') !== 'IEND'
    ) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete PNG`)
    }
    return validRasterMetadata('png', buffer.readUInt32BE(16), buffer.readUInt32BE(20), filePath)
  }

  const gifHeader = buffer.subarray(0, 6).toString('ascii')
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    if (buffer.length < 14 || buffer.at(-1) !== 0x3b) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete GIF`)
    }
    return validRasterMetadata('gif', buffer.readUInt16LE(6), buffer.readUInt16LE(8), filePath)
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const dimensions = jpegDimensions(buffer)
    if (!dimensions || buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) < 2) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete JPEG`)
    }
    return validRasterMetadata('jpeg', dimensions.width, dimensions.height, filePath)
  }

  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    if (buffer.length < 30 || buffer.readUInt32LE(4) + 8 > buffer.length) {
      throw new Error(`visual file ${path.basename(filePath)} is not a complete WebP`)
    }
    const dimensions = webpDimensions(buffer)
    if (!dimensions) throw new Error(`visual file ${path.basename(filePath)} has invalid WebP data`)
    return validRasterMetadata('webp', dimensions.width, dimensions.height, filePath)
  }

  throw new Error(
    `visual file ${path.basename(filePath)} must be a recognizable PNG, JPEG, WebP, or GIF`,
  )
}

function validRasterMetadata(
  format: RasterMetadata['format'],
  width: number,
  height: number,
  filePath: string,
): RasterMetadata {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`visual file ${path.basename(filePath)} has invalid dimensions`)
  }
  return { format, width, height }
}

function jpegDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ])
  let offset = 2
  while (offset + 3 < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1
    const marker = buffer[offset++]
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > buffer.length) break
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) break
    if (startOfFrame.has(marker) && length >= 7) {
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return undefined
}

function webpDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  const kind = buffer.subarray(12, 16).toString('ascii')
  if (kind === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    }
  }
  if (
    kind === 'VP8 ' &&
    buffer.length >= 30 &&
    buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
  ) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (kind === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
    const bits = buffer.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) }
  }
  return undefined
}
