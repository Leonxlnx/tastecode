import assert from 'node:assert/strict'
import { test } from 'node:test'

import { compareDottedVersions, declaredLibcFloor, maxSymbolVersion } from './linux-acceptance.js'

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
