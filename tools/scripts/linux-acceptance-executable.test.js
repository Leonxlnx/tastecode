import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { packagedExecutable } from './linux-acceptance-executable.js'

const linuxOnly = { skip: process.platform !== 'linux' }

test(
  'selects the app executable without treating Electron shared libraries as apps',
  linuxOnly,
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-linux-executable-'))
    const appExecutable = path.join(directory, '@harnessdesktop')

    try {
      for (const name of [
        '@harnessdesktop',
        'chrome-sandbox',
        'chrome_crashpad_handler',
        'libEGL.so',
        'libGLESv2.so',
        'libffmpeg.so',
        'libvk_swiftshader.so',
        'libvulkan.so.1',
      ]) {
        const file = path.join(directory, name)
        await writeFile(file, '')
        await chmod(file, 0o755)
      }

      assert.equal(packagedExecutable(directory), appExecutable)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

test('fails closed when more than one application executable remains', linuxOnly, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tastecode-linux-executable-'))

  try {
    for (const name of ['@harnessdesktop', 'unexpected-executable']) {
      const file = path.join(directory, name)
      await writeFile(file, '')
      await chmod(file, 0o755)
    }

    assert.throws(() => packagedExecutable(directory), /expected one app executable, found 2/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
