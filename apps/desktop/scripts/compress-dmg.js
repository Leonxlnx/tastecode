// electron-builder `artifactBuildCompleted` hook: recompress the finished DMG with LZMA.
//
// electron-builder only accepts zlib/bzip2/lzfse DMG formats. ULMO (LZMA, macOS 10.15+) makes the
// Electron framework about 30 MB smaller in the download. The hook runs after electron-builder has
// signed the DMG and written its blockmap but before the update info is recorded, so it re-signs
// with the same identity, rebuilds the blockmap and replaces the recorded size and hash.
import { execFileSync, spawnSync } from 'node:child_process'
import { renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

// codesign prints signature details on stderr and exits non-zero for unsigned files.
function signingAuthority(file) {
  const result = spawnSync('codesign', ['-d', '--verbose=2', file], { encoding: 'utf8' })
  const output = `${result.stdout}${result.stderr}`
  if (result.status !== 0) {
    if (/not signed at all/.test(output)) return null
    throw new Error(`codesign could not read the DMG signature: ${output.trim()}`)
  }
  const authority = /^Authority=(.+)$/m.exec(output)?.[1]
  if (!authority) throw new Error(`The signed DMG has no signing authority: ${output.trim()}`)
  return authority
}

// Sign by certificate hash, as electron-builder does, so duplicate certificate names stay unambiguous.
function identityHash(authority, keychainFile) {
  const args = ['find-identity', '-v', '-p', 'codesigning']
  if (keychainFile) args.push(keychainFile)
  const identities = execFileSync('security', args, { encoding: 'utf8' })
  for (const match of identities.matchAll(/^\s*\d+\) ([0-9A-F]{40}) "(.+)"$/gm))
    if (match[2] === authority) return match[1]
  throw new Error(`No code-signing identity named "${authority}" is available to re-sign the DMG`)
}

function buildBlockMap(file) {
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const { buildBlockMap } = builderRequire('app-builder-lib/out/targets/blockmap/blockmap.js')
  return buildBlockMap(file, 'gzip', `${file}.blockmap`)
}

export default async function compressDmg(event) {
  const file = event.file
  if (process.platform !== 'darwin' || path.extname(file) !== '.dmg') return

  const authority = signingAuthority(file)
  const converted = path.join(path.dirname(file), `.${path.basename(file, '.dmg')}-ulmo.dmg`)
  rmSync(converted, { force: true })
  execFileSync('hdiutil', ['convert', file, '-quiet', '-format', 'ULMO', '-o', converted])
  renameSync(converted, file)

  if (authority) {
    const { keychainFile } = await event.packager.codeSigningInfo.value
    const args = ['--sign', identityHash(authority, keychainFile)]
    if (keychainFile) args.push('--keychain', keychainFile)
    execFileSync('codesign', [...args, file])
  }

  const info = await buildBlockMap(file)
  if (event.updateInfo) Object.assign(event.updateInfo, info)
}
