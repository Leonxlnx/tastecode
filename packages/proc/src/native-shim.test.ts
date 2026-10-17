import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invalidateCommandCache, nativeShimTarget } from './cli.js'

// npm 10/11 cmd-shim output for a package whose bin is a Windows executable,
// copied from the opencode.cmd that `npm i -g opencode-ai` wrote on Windows 11.
const NATIVE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  '',
].join('\r\n')

// The same generator's shim for a node script (codex.cmd from @openai/codex), which must
// keep going through cmd.
const NODE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  '',
].join('\r\n')

const folders: string[] = []
afterEach(async () => {
  invalidateCommandCache()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function npmFolder(files: Record<string, string>) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'harness-shim-'))
  folders.push(folder)
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
    await writeFile(path.join(folder, name), content)
  }
  return { folder, env: { ...process.env, PATH: folder, Path: folder, PATHEXT: '.EXE;.CMD' } }
}

describe.runIf(process.platform === 'win32')('npm native shim target', () => {
  it('finds the executable a native npm shim forwards to', async () => {
    const { folder, env } = await npmFolder({
      'opencode.cmd': NATIVE_SHIM,
      'node_modules/opencode-ai/bin/opencode.exe': 'MZ',
    })
    await expect(nativeShimTarget('opencode', env)).resolves.toBe(
      path.win32.join(folder, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    )
  })

  it('keeps a node script shim, an edited shim and a missing target on cmd', async () => {
    const { env } = await npmFolder({
      'codex.cmd': NODE_SHIM,
      'edited.cmd': NATIVE_SHIM.replace('SETLOCAL', 'SETLOCAL\r\nSET OPENCODE_FLAG=1'),
      'gone.cmd': NATIVE_SHIM,
    })
    await expect(nativeShimTarget('codex', env)).resolves.toBeUndefined()
    await expect(nativeShimTarget('edited', env)).resolves.toBeUndefined()
    await expect(nativeShimTarget('gone', env)).resolves.toBeUndefined()
    await expect(nativeShimTarget('missing', env)).resolves.toBeUndefined()
  })
})
