import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  linuxPreparationCommands,
  stageLinuxDistribution,
  withLinuxPreparationLock,
} from './prepare-linux-release.js'
import {
  ACCEPTANCE_PREPARATION_ARGS,
  ACCEPTANCE_VALIDATION_SCRIPTS,
} from '../../../tools/scripts/linux-acceptance.js'

const desktopPackage = {
  name: '@harness/desktop',
  productName: 'Taste Code',
  version: '9.9.9-test.1',
  build: { artifactName: 'TasteCode-${version}-${os}-${arch}.${ext}' },
}
const artifacts = [
  'TasteCode-9.9.9-test.1-linux-amd64.deb',
  'TasteCode-9.9.9-test.1-linux-x86_64.AppImage',
]

test('one preparation owns exactly one root build', () => {
  const commands = linuxPreparationCommands('/workspace')
  assert.equal(commands.filter((entry) => entry.phase === 'build').length, 1)
  assert.deepEqual(
    commands.find((entry) => entry.phase === 'build'),
    { command: 'pnpm', args: ['build'], cwd: '/workspace', phase: 'build' },
  )
  assert.equal(
    commands.some((entry) => entry.args.some((value) => value.startsWith('dist'))),
    false,
  )
  assert.deepEqual(commands.find((entry) => entry.phase === 'package').args, [
    '--dir',
    '/workspace/apps/desktop',
    'exec',
    'electron-builder',
    '--linux',
    'AppImage',
    'deb',
    '--x64',
    '--config.directories.output=../../release/.linux-package',
  ])
  assert.deepEqual(ACCEPTANCE_VALIDATION_SCRIPTS, ['lint', 'typecheck', 'test'])
  assert.deepEqual(ACCEPTANCE_PREPARATION_ARGS, ['--filter', '@harness/desktop', 'dist:linux'])
})

test('Linux packaging disables publisher and update metadata generation only on Linux', async () => {
  const packageJson = JSON.parse(
    await readFile(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    ),
  )
  assert.equal(packageJson.build.linux.publish, null)
  assert.deepEqual(packageJson.build.publish, [
    { provider: 'generic', url: 'https://tastecode.dev/releases' },
  ])
})

test('refuses concurrent writers to the shared Linux release output', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-linux-lock-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const lock = path.join(root, '.linux-prepare.lock')
  let release
  let acquired
  const blocked = new Promise((resolve) => {
    release = resolve
  })
  const ready = new Promise((resolve) => {
    acquired = resolve
  })
  const first = withLinuxPreparationLock(lock, async () => {
    acquired()
    await blocked
  })
  await ready

  await assert.rejects(
    withLinuxPreparationLock(lock, async () => undefined),
    /Linux release preparation lock .* is held by process/,
  )
  release()
  await first
  await assert.doesNotReject(withLinuxPreparationLock(lock, async () => undefined))
})

test('stages only the two manual Linux distribution artifacts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-linux-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'private')
  const destination = path.join(root, 'distribution')
  await mkdir(source, { recursive: true })
  for (const name of artifacts) await writeFile(path.join(source, name), `fixture:${name}`)
  await writeFile(path.join(source, 'beta-linux.yml'), 'private builder sidecar')
  await writeFile(path.join(source, `${artifacts[1]}.blockmap`), 'private builder sidecar')

  assert.deepEqual(await stageLinuxDistribution(source, destination, desktopPackage), artifacts)
  assert.deepEqual(await readdir(destination), artifacts)
  for (const name of artifacts) {
    assert.equal(await readFile(path.join(destination, name), 'utf8'), `fixture:${name}`)
  }
})

test('refuses linked or empty packaged artifacts', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tastecode-linux-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const destination = path.join(root, 'distribution')
  await writeFile(path.join(root, artifacts[0]), '')
  await writeFile(path.join(root, 'payload'), 'fixture')
  await symlink(path.join(root, 'payload'), path.join(root, artifacts[1]))

  await assert.rejects(
    stageLinuxDistribution(root, destination, desktopPackage),
    /nonempty regular file/,
  )
  await writeFile(path.join(root, artifacts[0]), 'fixture')
  await assert.rejects(
    stageLinuxDistribution(root, destination, desktopPackage),
    /nonempty regular file/,
  )
})
