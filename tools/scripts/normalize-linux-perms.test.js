import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  normalizeAssetSources,
  normalizePayloadTree,
  payloadFileMode,
  stripPayloadBinaries,
} from './normalize-linux-perms.js'

async function withDir(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-perms-test-'))
  try {
    return await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const modeOf = async (entry) => (await lstat(entry)).mode & 0o7777

test('payloadFileMode keeps executables and flattens shared objects to 0644', () => {
  assert.equal(payloadFileMode('tastecode', 0o775), 0o755)
  assert.equal(payloadFileMode('chrome-sandbox', 0o4755), 0o4755)
  assert.equal(payloadFileMode('libvulkan.so.1', 0o755), 0o644)
  assert.equal(payloadFileMode('libEGL.so', 0o664), 0o644)
  assert.equal(payloadFileMode('pty.node', 0o664), 0o644)
  assert.equal(payloadFileMode('icudtl.dat', 0o664), 0o644)
})

test('normalizePayloadTree applies Debian modes and collects strip candidates', () =>
  withDir(async (root) => {
    const lib = path.join(root, 'libffmpeg.so')
    const binary = path.join(root, 'tastecode')
    const nested = path.join(root, 'resources', 'app.asar.unpacked')
    const addon = path.join(nested, 'pty.node')
    await mkdir(nested, { recursive: true, mode: 0o775 })
    await writeFile(lib, 'elf', { mode: 0o755 })
    await writeFile(binary, 'elf', { mode: 0o775 })
    await writeFile(addon, 'elf', { mode: 0o664 })
    await writeFile(path.join(root, 'resources.pak'), 'pak', { mode: 0o664 })
    await chmod(root, 0o775)

    const { directories, files, strippable } = await normalizePayloadTree(root)
    assert.equal(await modeOf(root), 0o755)
    assert.equal(await modeOf(lib), 0o644)
    assert.equal(await modeOf(binary), 0o755)
    assert.equal(await modeOf(addon), 0o644)
    assert.equal(await modeOf(path.join(root, 'resources.pak')), 0o644)
    assert.equal(await modeOf(nested), 0o755)
    assert.deepEqual(strippable, [addon])
    assert.equal(directories, 3)
    assert.equal(files, 4)
  }))

test('normalizePayloadTree leaves symlinks untouched', () =>
  withDir(async (root) => {
    const target = path.join(root, 'libvulkan.so.1')
    const link = path.join(root, 'libvulkan.so')
    await writeFile(target, 'elf', { mode: 0o755 })
    await symlink('libvulkan.so.1', link)
    await normalizePayloadTree(root)
    assert.equal(await modeOf(target), 0o644)
    assert.equal((await lstat(link)).isSymbolicLink(), true)
  }))

test('normalizeAssetSources forces asset data to 0644', () =>
  withDir(async (root) => {
    const icon = path.join(root, 'icons', '512x512.png')
    await mkdir(path.dirname(icon), { recursive: true })
    await writeFile(icon, 'png', { mode: 0o664 })
    await writeFile(path.join(root, 'copyright'), 'license', { mode: 0o664 })
    await normalizeAssetSources(root)
    assert.equal(await modeOf(icon), 0o644)
    assert.equal(await modeOf(path.join(root, 'copyright')), 0o644)
  }))

test('stripPayloadBinaries requires strip and strips only listed binaries', async () => {
  await stripPayloadBinaries([])
  const calls = []
  const run = (command, args) => {
    calls.push([command, args])
    return ''
  }
  await stripPayloadBinaries(['/tmp/x/pty.node'], run)
  assert.deepEqual(calls, [
    ['strip', ['--version']],
    ['strip', ['--strip-unneeded', '/tmp/x/pty.node']],
  ])
  await assert.rejects(
    () =>
      stripPayloadBinaries(['/tmp/x/pty.node'], () => {
        throw new Error('spawn strip ENOENT')
      }),
    /strip is required on PATH/,
  )
})
