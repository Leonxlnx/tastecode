// Fetches the Agent Skills TasteCode ships by default from their pinned GitHub
// commits, checks them against skills.json and lays them out as one folder that
// is both a plain skills tree (`skills/<name>/SKILL.md`) and a Claude Code
// plugin (`.claude-plugin/plugin.json`), with a copy of skills.json for the app.
//
//   node scripts/sync.js            fetch when the bundle is missing or differs
//   node scripts/sync.js --verify   check the bundle only; exit 1 when it is off
//   node scripts/sync.js --update   fetch and write the measured hashes into
//                                   skills.json (after moving a pin on purpose)
//
// The bundle is gitignored: the skill files are about 39 MB, so only the pins
// and their hashes live in the repository.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { digestFiles, skillFiles } from './skill-media.mjs'

export { digestFiles, isStray, skillFiles, tarEntries } from './skill-media.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const packageRoot = path.resolve(here, '..')
export const manifestPath = path.join(packageRoot, 'skills.json')
export const bundleRoot = path.join(packageRoot, 'bundle')

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/** The plugin manifest Claude Code reads; its name is the prefix skills show under. */
export function pluginManifest(manifest) {
  return `${JSON.stringify(manifest.plugin, null, 2)}\n`
}

async function readTree(root, relative = '', into = new Map()) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) await readTree(root, child, into)
    else if (entry.isFile()) into.set(child, await readFile(path.join(root, child)))
    else throw new Error(`Unexpected non-file in bundle: ${child}`)
  }
  return into
}

export async function readManifest(file = manifestPath) {
  return JSON.parse(await readFile(file, 'utf8'))
}

/** Problems with an existing bundle, or an empty list when it matches the manifest exactly. */
export async function verifyBundle(manifest, root = bundleRoot) {
  const problems = []
  try {
    if (!(await stat(root)).isDirectory()) return [`${root} is not a folder`]
  } catch {
    return [`${root} is missing; run pnpm --filter @harness/default-skills sync`]
  }
  try {
    const plugin = await readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8')
    if (plugin !== pluginManifest(manifest)) problems.push('plugin.json differs from skills.json')
  } catch {
    problems.push('plugin.json is missing')
  }
  try {
    const copy = JSON.parse(await readFile(path.join(root, 'skills.json'), 'utf8'))
    if (JSON.stringify(copy) !== JSON.stringify(manifest))
      problems.push('skills.json in the bundle differs from the pinned one')
  } catch {
    problems.push('skills.json is missing from the bundle')
  }
  const expected = new Set(['.claude-plugin', 'skills', 'skills.json'])
  for (const name of await readdir(root))
    if (!expected.has(name)) problems.push(`unexpected entry in bundle: ${name}`)
  let folders = []
  try {
    folders = await readdir(path.join(root, 'skills'))
  } catch {
    problems.push('skills folder is missing')
  }
  const wanted = new Set(manifest.skills.map((skill) => skill.folder))
  for (const folder of folders)
    if (!wanted.has(folder)) problems.push(`unexpected skill folder: ${folder}`)
  for (const skill of manifest.skills) {
    const dir = path.join(root, 'skills', skill.folder)
    let files
    try {
      files = await readTree(dir)
    } catch {
      problems.push(`${skill.folder} is missing`)
      continue
    }
    const digest = digestFiles(files)
    if (digest.treeSha256 !== skill.treeSha256)
      problems.push(
        `${skill.folder} differs from its pin (${digest.files} files, ${digest.bytes} bytes; expected ${skill.files} files, ${skill.bytes} bytes)`,
      )
  }
  return problems
}

async function fetchArchive(skill, fetchImpl) {
  const url = `https://codeload.github.com/${skill.repository}/tar.gz/${skill.commit}`
  const response = await fetchImpl(url)
  if (!response.ok) throw new Error(`${skill.folder}: ${url} answered ${response.status}`)
  const gz = Buffer.from(await response.arrayBuffer())
  if (gz.length > MAX_ARCHIVE_BYTES) throw new Error(`${skill.folder}: archive is too large`)
  return gz
}

/**
 * Builds the bundle next to the old one and swaps it in only when every skill
 * matched its pin. With `update`, the measured hashes are returned instead of
 * checked so a maintainer can move a pin deliberately.
 */
export async function syncBundle(
  manifest,
  { root = bundleRoot, fetchImpl = fetch, update = false, log = console.log } = {},
) {
  if (!update && (await verifyBundle(manifest, root)).length === 0) {
    log('Default skills are up to date.')
    return manifest
  }
  const staging = `${root}.staging-${process.pid}`
  await rm(staging, { recursive: true, force: true })
  const next = { ...manifest, skills: [] }
  try {
    for (const skill of manifest.skills) {
      const gz = await fetchArchive(skill, fetchImpl)
      const archiveSha256 = createHash('sha256').update(gz).digest('hex')
      if (!update && archiveSha256 !== skill.archiveSha256)
        throw new Error(
          `${skill.folder}: archive sha256 ${archiveSha256} does not match the pinned ${skill.archiveSha256}`,
        )
      const files = skillFiles(gunzipSync(gz), skill)
      const digest = digestFiles(files)
      if (!update && digest.treeSha256 !== skill.treeSha256)
        throw new Error(`${skill.folder}: extracted files do not match the pinned tree hash`)
      for (const [relative, body] of files) {
        const target = path.join(staging, 'skills', skill.folder, ...relative.split('/'))
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, body)
      }
      next.skills.push({ ...skill, archiveSha256, ...digest })
      log(`${skill.folder}: ${digest.files} files, ${digest.bytes} bytes @ ${skill.commit}`)
    }
    await mkdir(path.join(staging, '.claude-plugin'), { recursive: true })
    await writeFile(path.join(staging, '.claude-plugin', 'plugin.json'), pluginManifest(manifest))
    // The app reads names and summaries from here; the source tree is not shipped.
    await writeFile(path.join(staging, 'skills.json'), `${JSON.stringify(next, null, 2)}\n`)
    await rm(root, { recursive: true, force: true })
    await rename(staging, root)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return next
}

async function main(argv) {
  const manifest = await readManifest()
  if (argv.includes('--verify')) {
    const problems = await verifyBundle(manifest)
    if (problems.length) {
      for (const problem of problems) console.error(`default skills: ${problem}`)
      process.exitCode = 1
    } else console.log('Default skills match skills.json.')
    return
  }
  const update = argv.includes('--update')
  const next = await syncBundle(manifest, { update })
  if (update) await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
