import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DIRECT_TABLE_START = '<!-- BEGIN DIRECT RUNTIME DEPENDENCIES -->'
const DIRECT_TABLE_END = '<!-- END DIRECT RUNTIME DEPENDENCIES -->'
const STANDARD_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'OFL-1.1',
  'Python-2.0',
  'Unicode-3.0',
  'Unlicense',
])
const STANDARD_EXCEPTIONS = new Set(['Classpath-exception-2.0'])

function packagePath(packageName) {
  return packageName.split('/')
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function normalizedLicense(value) {
  if (typeof value === 'string') return value.trim().replaceAll(/\s+/g, ' ')
  if (value && typeof value === 'object' && typeof value.type === 'string') {
    return value.type.trim().replaceAll(/\s+/g, ' ')
  }
  return undefined
}

function declaredLicense(packageJson) {
  const direct = normalizedLicense(packageJson.license)
  if (direct) return direct
  if (Array.isArray(packageJson.licenses)) {
    const licenses = packageJson.licenses.map(normalizedLicense).filter(Boolean)
    if (licenses.length > 0) return licenses.join(' OR ')
  }
  return undefined
}

function isStandardLicenseExpression(expression) {
  const tokens = expression.match(/[A-Za-z0-9.+-]+/g)
  if (!tokens || tokens.length === 0) return false

  let expectsException = false
  for (const token of tokens) {
    if (token === 'AND' || token === 'OR') continue
    if (token === 'WITH') {
      expectsException = true
      continue
    }
    if (expectsException) {
      if (!STANDARD_EXCEPTIONS.has(token)) return false
      expectsException = false
      continue
    }
    if (!STANDARD_LICENSES.has(token)) return false
  }
  return !expectsException
}

export async function loadLicenseInventory(repositoryRoot) {
  return readJson(path.join(repositoryRoot, 'licenses', 'direct-runtime-dependencies.json'))
}

async function workspacePackages(repositoryRoot) {
  const locations = []
  for (const group of ['apps', 'packages']) {
    const groupRoot = path.join(repositoryRoot, group)
    for (const entry of await readdir(groupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(groupRoot, entry.name)
      try {
        const packageJson = await readJson(path.join(directory, 'package.json'))
        locations.push({ directory, packageJson })
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
  return locations
}

export async function deriveDirectRuntimeDependencies(repositoryRoot, inventory) {
  const workspaces = await workspacePackages(repositoryRoot)
  const byName = new Map(workspaces.map((workspace) => [workspace.packageJson.name, workspace]))
  const roots = inventory.workspaceRoots.map((relativePath) => {
    const absolutePath = path.join(repositoryRoot, relativePath)
    const workspace = workspaces.find((candidate) => candidate.directory === absolutePath)
    if (!workspace) throw new Error(`runtime workspace root is missing: ${relativePath}`)
    return workspace.packageJson.name
  })
  const visited = new Set()
  const externalOrigins = new Map()
  const queue = [...roots]

  while (queue.length > 0) {
    const workspaceName = queue.shift()
    if (visited.has(workspaceName)) continue
    visited.add(workspaceName)
    const workspace = byName.get(workspaceName)
    if (!workspace) throw new Error(`runtime workspace dependency is missing: ${workspaceName}`)

    for (const dependency of Object.keys(workspace.packageJson.dependencies ?? {})) {
      if (byName.has(dependency)) {
        queue.push(dependency)
        continue
      }
      const origins = externalOrigins.get(dependency) ?? new Set()
      origins.add(workspace.directory)
      externalOrigins.set(dependency, origins)
    }

    for (const dependency of inventory.runtimeDevDependencies?.[workspaceName] ?? []) {
      if (!(dependency in (workspace.packageJson.devDependencies ?? {}))) {
        throw new Error(`${workspaceName} does not declare runtime dev dependency ${dependency}`)
      }
      const origins = externalOrigins.get(dependency) ?? new Set()
      origins.add(workspace.directory)
      externalOrigins.set(dependency, origins)
    }
  }

  return [...externalOrigins]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, origins]) => ({ name, origins: [...origins].sort() }))
}

function validateInventory(inventory, derivedDependencies) {
  const errors = []
  const entries = new Map()
  for (const entry of inventory.dependencies) {
    if (entries.has(entry.name)) errors.push(`duplicate direct dependency inventory: ${entry.name}`)
    entries.set(entry.name, entry)
    if (
      !entry.use ||
      !entry.license ||
      !entry.source ||
      !Array.isArray(entry.metadataLicenses) ||
      entry.metadataLicenses.length === 0
    ) {
      errors.push(`incomplete direct dependency inventory: ${entry.name}`)
    }
  }

  const derived = new Set(derivedDependencies.map(({ name }) => name))
  for (const name of derived) {
    if (!entries.has(name)) errors.push(`direct runtime dependency is not inventoried: ${name}`)
  }
  for (const name of entries.keys()) {
    if (!derived.has(name)) errors.push(`inventory entry is not a direct runtime dependency: ${name}`)
  }
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return entries
}

function escapeMarkdown(value) {
  return value.replaceAll('|', '\\|')
}

export function renderDirectRuntimeTable(inventory) {
  const rows = [
    '<!-- prettier-ignore -->',
    '| npm package | Use | Reviewed license | Source |',
    '| --- | --- | --- | --- |',
  ]
  for (const entry of [...inventory.dependencies].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    rows.push(
      `| \`${entry.name}\` | ${escapeMarkdown(entry.use)} | ${escapeMarkdown(entry.license)} | [source](${entry.source}) |`,
    )
  }
  return rows.join('\n')
}

export async function verifyDirectRuntimeTable(repositoryRoot, inventory) {
  const notices = await readFile(path.join(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const start = notices.indexOf(DIRECT_TABLE_START)
  const end = notices.indexOf(DIRECT_TABLE_END)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('THIRD_PARTY_NOTICES.md is missing the managed direct-runtime table markers')
  }
  const actual = notices.slice(start + DIRECT_TABLE_START.length, end).trim()
  const expected = renderDirectRuntimeTable(inventory)
  if (actual !== expected) {
    throw new Error(
      'THIRD_PARTY_NOTICES.md direct-runtime table is stale; update it from the license inventory',
    )
  }
}

export async function verifyProjectLicense(repositoryRoot) {
  const licensePath = path.join(repositoryRoot, 'LICENSE')
  let contents
  try {
    contents = await readFile(licensePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('top-level LICENSE is missing; add the complete Apache-2.0 license text')
    }
    throw error
  }
  if (
    contents.length < 8_000 ||
    !contents.includes('Apache License') ||
    !contents.includes('Version 2.0')
  ) {
    throw new Error('top-level LICENSE is not the complete Apache-2.0 license text')
  }
}

async function installedPackage(repositoryRoot, fromDirectory, packageName) {
  let cursor = path.resolve(fromDirectory)
  const root = path.resolve(repositoryRoot)
  const segments = packagePath(packageName)

  while (true) {
    const candidates = [path.join(cursor, 'node_modules', ...segments, 'package.json')]
    if (path.basename(cursor) === 'node_modules') {
      candidates.push(path.join(cursor, ...segments, 'package.json'))
    }
    for (const candidate of candidates) {
      try {
        const resolvedPackageJson = await realpath(candidate)
        return {
          packageJsonPath: resolvedPackageJson,
          packageRoot: path.dirname(resolvedPackageJson),
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }

    if (cursor === root) break
    const parent = path.dirname(cursor)
    const relativeParent = path.relative(root, parent)
    if (
      parent === cursor ||
      relativeParent === '..' ||
      relativeParent.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeParent)
    ) {
      break
    }
    cursor = parent
  }
  return undefined
}

async function licenseFiles(packageRoot) {
  const matches = []
  for (const entry of await readdir(packageRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (/^(licen[cs]e|copying|notice)([._-].*)?$/i.test(entry.name)) matches.push(entry.name)
  }
  return matches.sort((left, right) => left.localeCompare(right))
}

function reviewedException(inventory, packageName, version) {
  return inventory.reviewedTransitiveExceptions?.find(
    (entry) => entry.name === packageName && (entry.version === undefined || entry.version === version),
  )
}

function metadataIsReviewed(entry, packageName, version, metadataLicense, inventory) {
  const accepted = entry ?? reviewedException(inventory, packageName, version)
  if (accepted && Array.isArray(accepted.metadataLicenses)) {
    return accepted.metadataLicenses.some(
      (candidate) => candidate.toLowerCase() === metadataLicense.toLowerCase(),
    )
  }
  return isStandardLicenseExpression(metadataLicense)
}

export async function auditInstalledProductionGraph(
  repositoryRoot,
  inventory,
  derivedDependencies,
) {
  const directEntries = validateInventory(inventory, derivedDependencies)
  const errors = []
  const unresolvedOptional = []
  const packages = []
  const visited = new Set()
  const queue = derivedDependencies.flatMap(({ name, origins }) =>
    origins.map((fromDirectory) => ({ name, fromDirectory, optional: false, direct: true })),
  )

  while (queue.length > 0) {
    const request = queue.shift()
    const resolved = await installedPackage(repositoryRoot, request.fromDirectory, request.name)
    if (!resolved) {
      if (request.optional) {
        unresolvedOptional.push(request.name)
      } else {
        errors.push(`installed production dependency is missing: ${request.name}`)
      }
      continue
    }
    if (visited.has(resolved.packageJsonPath)) continue
    visited.add(resolved.packageJsonPath)

    const packageJson = await readJson(resolved.packageJsonPath)
    const name = packageJson.name ?? request.name
    const version = packageJson.version ?? 'unknown'
    const metadataLicense = declaredLicense(packageJson)
    const files = await licenseFiles(resolved.packageRoot)
    const directEntry = directEntries.get(name)

    if (!metadataLicense) {
      errors.push(`${name}@${version} has no package license metadata`)
    } else if (!metadataIsReviewed(directEntry, name, version, metadataLicense, inventory)) {
      errors.push(`${name}@${version} has unreviewed license metadata: ${metadataLicense}`)
    }
    if (files.length === 0) {
      errors.push(`${name}@${version} does not ship a license, copying, or notice file`)
    }

    packages.push({
      name,
      version,
      direct: Boolean(directEntry),
      declaredLicense: metadataLicense ?? null,
      reviewedLicense: directEntry?.license ?? reviewedException(inventory, name, version)?.license ?? null,
      licenseFiles: files,
    })

    for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
      queue.push({
        name: dependency,
        fromDirectory: resolved.packageRoot,
        optional: false,
        direct: false,
      })
    }
    for (const dependency of Object.keys(packageJson.optionalDependencies ?? {})) {
      queue.push({
        name: dependency,
        fromDirectory: resolved.packageRoot,
        optional: true,
        direct: false,
      })
    }
    for (const dependency of Object.keys(packageJson.peerDependencies ?? {})) {
      if (packageJson.peerDependenciesMeta?.[dependency]?.optional) continue
      queue.push({
        name: dependency,
        fromDirectory: resolved.packageRoot,
        optional: false,
        direct: false,
      })
    }
  }

  packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  )
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return {
    schemaVersion: 1,
    platform: process.platform,
    architecture: process.arch,
    packageCount: packages.length,
    packages,
    unresolvedOptional: [...new Set(unresolvedOptional)].sort(),
  }
}

export async function verifyReleaseLicenses(repositoryRoot, options = {}) {
  const inventory = await loadLicenseInventory(repositoryRoot)
  const derived = await deriveDirectRuntimeDependencies(repositoryRoot, inventory)
  validateInventory(inventory, derived)
  await verifyDirectRuntimeTable(repositoryRoot, inventory)
  if (options.verifyProjectLicense !== false) await verifyProjectLicense(repositoryRoot)
  const report = await auditInstalledProductionGraph(repositoryRoot, inventory, derived)
  return { inventory, report }
}

function argumentsFrom(argv) {
  const options = { output: undefined, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') options.json = true
    else if (argument === '--output') options.output = argv[++index]
    else throw new Error(`unknown argument: ${argument}`)
  }
  if (options.output === undefined && argv.includes('--output')) {
    throw new Error('--output requires a path')
  }
  return options
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2))
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const { report } = await verifyReleaseLicenses(repositoryRoot)
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (options.output) {
    const outputPath = path.resolve(repositoryRoot, options.output)
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(outputPath, serialized, 'utf8')
  }
  if (options.json) process.stdout.write(serialized)
  else process.stdout.write(`verified license metadata for ${report.packageCount} packages\n`)
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (isEntryPoint) {
  main().catch((error) => {
    process.stderr.write(`[licenses] ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
