import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  compareDottedVersions,
  declaredLibcFloor,
  maxSymbolVersion,
  nativeBinaryCandidates,
} from './linux-acceptance.js'

test('maxSymbolVersion picks the highest GLIBC tag in objdump output', () => {
  const output = [
    'DYNAMIC SYMBOL TABLE:',
    '0000000000000000  w   D  *UND*  0000000000000000  GLIBC_2.2.5  puts',
    '0000000000000000      DF *UND*  0000000000000000  GLIBC_2.28   fstatat64',
    '0000000000000000      DF *UND*  0000000000000000  GLIBC_2.17   clock_gettime',
    '0000000000000000      DF *UND*  0000000000000000  GLIBCXX_3.4.22 _ZNSt7__cxx',
  ].join('\n')
  assert.equal(maxSymbolVersion(output, 'GLIBC'), '2.28')
  assert.equal(maxSymbolVersion(output, 'GLIBCXX'), '3.4.22')
})

test('maxSymbolVersion compares segments numerically, not lexically', () => {
  const output = 'GLIBC_2.9 x\nGLIBC_2.17 y\nGLIBC_2.34 z'
  assert.equal(maxSymbolVersion(output, 'GLIBC'), '2.34')
})

test('maxSymbolVersion returns undefined when the prefix is absent', () => {
  assert.equal(maxSymbolVersion('no version tags here', 'GLIBC'), undefined)
})

test('compareDottedVersions orders equal-length and ragged versions', () => {
  assert.ok(compareDottedVersions('2.28', '2.31') < 0)
  assert.ok(compareDottedVersions('2.31', '2.31') === 0)
  assert.ok(compareDottedVersions('2.9', '2.17') < 0)
  assert.ok(compareDottedVersions('3', '2.99') > 0)
  assert.ok(compareDottedVersions('2.31.1', '2.31') > 0)
})

test('declaredLibcFloor extracts the libc6 constraint', () => {
  assert.equal(
    declaredLibcFloor(['libc6 (>= 2.31)', 'libgtk-3-0t64 | libgtk-3-0', 'xdg-utils']),
    '2.31',
  )
  assert.equal(declaredLibcFloor(['libgtk-3-0']), undefined)
  assert.equal(declaredLibcFloor(undefined), undefined)
  assert.equal(declaredLibcFloor(['libc6']), undefined)
})

test('nativeBinaryCandidates finds the executable and every shipped addon or library', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'linux-acceptance-binaries-'))
  mkdirSync(path.join(root, 'resources', 'app.asar.unpacked'), { recursive: true })
  writeFileSync(path.join(root, 'tastecode'), 'elf')
  writeFileSync(path.join(root, 'libffmpeg.so'), 'elf')
  writeFileSync(path.join(root, 'resources', 'app.asar.unpacked', 'pty.node'), 'elf')
  writeFileSync(path.join(root, 'chrome-sandbox'), 'elf')
  writeFileSync(path.join(root, 'README.txt'), 'text')
  const found = nativeBinaryCandidates(root, 'tastecode').map((name) =>
    path.relative(root, name).split(path.sep).join('/'),
  )
  assert.deepEqual(found.sort(), [
    'chrome-sandbox',
    'libffmpeg.so',
    'resources/app.asar.unpacked/pty.node',
    'tastecode',
  ])
  // Optional helper binaries that are absent are skipped, not required.
  assert.ok(!found.includes('chrome_crashpad_handler'))
})
