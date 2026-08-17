import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type BoundaryValue, member, optionalString, record, string, strings } from './parse.js'
import { propertiesWhen } from './properties-when.js'

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

export function parseAssetManifest(value: BoundaryValue): AssetManifest {
  const manifest = record(value, 'asset manifest')
  if (manifest.version !== 1) throw new Error('asset manifest version must be 1')
  if (!Array.isArray(manifest.assets)) throw new Error('assets must be an array')

  const assets = manifest.assets.map((value, index) => {
    const asset = record(value, `assets[${index}]`)
    const status = member(asset.status, ASSET_STATUSES, `assets[${index}].status`)
    const source = optionalSource(asset.source, `assets[${index}].source`)
    const destination = optionalString(asset.destination, `assets[${index}].destination`)
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

    return {
      id: string(asset.id, `assets[${index}].id`),
      kind: member(asset.kind, ASSET_KINDS, `assets[${index}].kind`),
      status,
      purpose: string(asset.purpose, `assets[${index}].purpose`),
      requirements: strings(asset.requirements, `assets[${index}].requirements`),
      ...propertiesWhen(source, (source) => ({ source })),
      ...propertiesWhen(destination, (destination) => ({ destination })),
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

export function writeAssetManifest(workspacePath: string, value: BoundaryValue): AssetManifest {
  const manifest = parseAssetManifest(value)
  const outputPath = assetPath(workspacePath)
  mkdirSync(path.dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function assetPath(workspacePath: string): string {
  return path.join(workspacePath, '.taste', 'assets.json')
}

function optionalSource(value: BoundaryValue, field: string): DesignAsset['source'] {
  if (value === undefined) return undefined
  const source = record(value, field)
  const license = optionalString(source.license, `${field}.license`)
  return {
    kind: member(source.kind, SOURCE_KINDS, `${field}.kind`),
    reference: string(source.reference, `${field}.reference`),
    ...propertiesWhen(license, (license) => ({ license })),
  }
}
