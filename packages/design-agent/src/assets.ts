import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ASSET_KINDS = ['image', 'illustration', 'video', 'icon', 'font', 'component'] as const
const ASSET_STATUSES = ['existing', 'needed', 'ready'] as const
const SOURCE_KINDS = ['project', 'user', 'origin-kit', 'generated', 'external'] as const

export type AssetKind = (typeof ASSET_KINDS)[number]
export type AssetStatus = (typeof ASSET_STATUSES)[number]
export type AssetSourceKind = (typeof SOURCE_KINDS)[number]

export interface DesignAsset {
  id: string
  kind: AssetKind
  status: AssetStatus
  purpose: string
  requirements: string[]
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

    if (status === 'ready' && (!source || !destination)) {
      throw new Error(`assets[${index}] ready assets require source and destination`)
    }
    if (status === 'existing' && !source) {
      throw new Error(`assets[${index}] existing assets require a source`)
    }

    return {
      id: string(asset.id, `assets[${index}].id`),
      kind: member(asset.kind, ASSET_KINDS, `assets[${index}].kind`),
      status,
      purpose: string(asset.purpose, `assets[${index}].purpose`),
      requirements: strings(asset.requirements, `assets[${index}].requirements`),
      ...(source ? { source } : {}),
      ...(destination ? { destination } : {}),
    }
  })

  if (new Set(assets.map((asset) => asset.id)).size !== assets.length) {
    throw new Error('asset ids must be unique')
  }

  return { version: 1, assets }
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

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field)
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`${field} must be a string array`)
  }
  return value
}

function member<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${field} must be one of ${values.join(', ')}`)
  }
  return value as T
}
